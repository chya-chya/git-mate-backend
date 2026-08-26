import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalysisJobStage, AnalysisJobStatus } from '@prisma/client';
import type { SQSRecord } from 'aws-lambda';
import { RateLimitError } from 'openai';
import {
  AnalysisJobExecutionOutcome,
  AnalysisJobRunnerService,
} from '../../analysis/analysis.service';
import { RepositoryCollectionService } from '../../collection/repository-collection.service';
import { AnalysisWorkerErrorClassifier } from '../analysis-worker-error-classifier';
import {
  AnalysisWorkerJob,
  AnalysisWorkerRepository,
} from '../analysis-worker.repository';
import { AnalysisWorkerService } from '../analysis-worker.service';

describe('AnalysisWorkerService', () => {
  const jobId = '8fe6a55c-956a-4d8f-985f-fcf2bc72e34c';
  const collectedData = {
    githubRepoId: '11',
    owner: 'owner',
    repo: 'repo',
    targetUser: 'developer',
    pullRequests: [],
  };
  const repository = {
    claim: jest.fn(),
    updateProgress: jest.fn(),
    failQueuedInvalidMessage: jest.fn(),
    releaseForRetry: jest.fn(),
    finalizeRunningFailure: jest.fn(),
    finalizeQueuedAtLimit: jest.fn(),
    advanceRepositoryCheckpoint: jest.fn(),
  };
  const repositoryCollection = { collect: jest.fn() };
  const analysisJobRunner = { runAnalysisJob: jest.fn() };
  const service = new AnalysisWorkerService(
    repository as unknown as AnalysisWorkerRepository,
    repositoryCollection as unknown as RepositoryCollectionService,
    analysisJobRunner as unknown as AnalysisJobRunnerService,
    new AnalysisWorkerErrorClassifier(),
    new ConfigService({
      ASYNC_ANALYSIS_ENABLED: 'false',
      ANALYSIS_WORKER_LEASE_SECONDS: '900',
      ANALYSIS_WORKER_RETRY_BASE_SECONDS: '30',
    }),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.updateProgress.mockResolvedValue(undefined);
    repository.failQueuedInvalidMessage.mockResolvedValue(true);
    repository.releaseForRetry.mockResolvedValue(undefined);
    repository.finalizeRunningFailure.mockResolvedValue(true);
    repository.finalizeQueuedAtLimit.mockResolvedValue(true);
    repository.advanceRepositoryCheckpoint.mockResolvedValue({ count: 1 });
    repositoryCollection.collect.mockResolvedValue(collectedData);
    analysisJobRunner.runAnalysisJob.mockResolvedValue({
      outcome: AnalysisJobExecutionOutcome.SUCCEEDED,
      metrics: {},
    });
  });

  it('acks malformed JSON without a database or external call', async () => {
    await expect(
      service.processBatch([createRecord('message-1', '{')], 'request-1'),
    ).resolves.toEqual({ batchItemFailures: [] });

    expect(repository.claim).not.toHaveBeenCalled();
    expect(repositoryCollection.collect).not.toHaveBeenCalled();
    expect(analysisJobRunner.runAnalysisJob).not.toHaveBeenCalled();
  });

  it('terminalizes an invalid version only while the Job is queued', async () => {
    const body = JSON.stringify({ schemaVersion: 2, jobId });

    await expect(
      service.processBatch([createRecord('message-1', body)], 'request-1'),
    ).resolves.toEqual({ batchItemFailures: [] });

    expect(repository.failQueuedInvalidMessage).toHaveBeenCalledWith(
      jobId,
      expect.any(Date),
    );
    expect(repositoryCollection.collect).not.toHaveBeenCalled();
    expect(analysisJobRunner.runAnalysisJob).not.toHaveBeenCalled();
  });

  it('acks a message for a missing or terminal Job without external calls', async () => {
    repository.claim
      .mockResolvedValueOnce({ kind: 'NOT_FOUND' })
      .mockResolvedValueOnce({ kind: 'TERMINAL' });
    const records = [createRecord('message-1'), createRecord('message-2')];

    await expect(service.processBatch(records, 'request-1')).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(repositoryCollection.collect).not.toHaveBeenCalled();
  });

  it('stops at an active lease and returns the current and remaining message IDs', async () => {
    repository.claim.mockResolvedValue({ kind: 'ACTIVE_LEASE' });
    const records = [
      createRecord('message-1'),
      createRecord('message-2'),
      createRecord('message-3'),
    ];

    await expect(service.processBatch(records, 'request-1')).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: 'message-1' },
        { itemIdentifier: 'message-2' },
        { itemIdentifier: 'message-3' },
      ],
    });
    expect(repository.claim).toHaveBeenCalledTimes(1);
  });

  it('uses DB-owned repository data, sourceCursor, progress hooks, and checkpoint completion', async () => {
    const job = createJob();
    repository.claim.mockResolvedValue({
      kind: 'CLAIMED',
      job,
      leaseToken: 'lease-1',
    });
    analysisJobRunner.runAnalysisJob.mockImplementation(
      async (
        _data: unknown,
        _context: unknown,
        completionAction: (transaction: object) => Promise<unknown>,
        options: {
          onTokensReserved: () => Promise<void>;
          onSaving: () => Promise<void>;
        },
      ) => {
        await options.onTokensReserved();
        await options.onSaving();
        await completionAction({ repository: {} });
        return {
          outcome: AnalysisJobExecutionOutcome.SUCCEEDED,
          metrics: {},
        };
      },
    );

    await expect(
      service.processBatch([createRecord('message-1')], 'request-1'),
    ).resolves.toEqual({ batchItemFailures: [] });

    expect(repositoryCollection.collect).toHaveBeenCalledWith({
      userId: 7,
      githubRepoId: '11',
      fullName: 'owner/repo',
      targetUser: 'developer',
      sourceCursor: job.sourceCursor,
    });
    expect(repository.updateProgress.mock.calls).toEqual([
      [
        expect.objectContaining({
          jobId,
          leaseToken: 'lease-1',
          stage: AnalysisJobStage.RESERVING_TOKENS,
          progress: 35,
        }),
      ],
      [
        expect.objectContaining({
          jobId,
          leaseToken: 'lease-1',
          stage: AnalysisJobStage.ANALYZING,
          progress: 55,
        }),
      ],
      [
        expect.objectContaining({
          jobId,
          leaseToken: 'lease-1',
          stage: AnalysisJobStage.SAVING,
          progress: 90,
        }),
      ],
    ]);
    expect(repository.advanceRepositoryCheckpoint).toHaveBeenCalledWith(job, {
      repository: {},
    });
  });

  it('requeues OpenAI rate limits while preserving the reservation', async () => {
    const job = createJob({ reservedTokens: 20 });
    repository.claim.mockResolvedValue({
      kind: 'CLAIMED',
      job,
      leaseToken: 'lease-1',
    });
    analysisJobRunner.runAnalysisJob.mockRejectedValue(
      new RateLimitError(429, {}, 'rate limited', new Headers()),
    );

    await expect(
      service.processBatch([createRecord('message-1')], 'request-1'),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-1' }],
    });

    expect(repository.releaseForRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        leaseToken: 'lease-1',
        errorCode: 'PROVIDER_TEMPORARY_FAILURE',
      }),
    );
    expect(repository.finalizeRunningFailure).not.toHaveBeenCalled();
  });

  it('terminalizes permanent GitHub access failures and acks the record', async () => {
    repository.claim.mockResolvedValue({
      kind: 'CLAIMED',
      job: createJob(),
      leaseToken: 'lease-1',
    });
    repositoryCollection.collect.mockRejectedValue(new ForbiddenException());

    await expect(
      service.processBatch([createRecord('message-1')], 'request-1'),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(repository.finalizeRunningFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        errorCode: 'REPOSITORY_UNAVAILABLE',
        errorRetryable: false,
      }),
    );
    expect(analysisJobRunner.runAnalysisJob).not.toHaveBeenCalled();
  });

  it('settles the final retryable failure but still returns the record for DLQ redrive', async () => {
    repository.claim.mockResolvedValue({
      kind: 'CLAIMED',
      job: createJob({ attemptCount: 5, maxAttempts: 5 }),
      leaseToken: 'lease-1',
    });
    analysisJobRunner.runAnalysisJob.mockRejectedValue({ status: 503 });

    await expect(
      service.processBatch(
        [createRecord('message-1', undefined, 5)],
        'request-1',
      ),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-1' }],
    });
    expect(repository.finalizeRunningFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'MAX_ATTEMPTS_EXCEEDED',
        errorRetryable: true,
      }),
    );
    expect(repository.releaseForRetry).not.toHaveBeenCalled();
  });

  it('processes an already-published message while the public flag is false', async () => {
    repository.claim.mockResolvedValue({ kind: 'TERMINAL' });

    await expect(
      service.processBatch([createRecord('message-1')], 'request-1'),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(repository.claim).toHaveBeenCalledTimes(1);
  });

  function createJob(
    overrides: Partial<AnalysisWorkerJob> = {},
  ): AnalysisWorkerJob {
    return {
      id: jobId,
      status: AnalysisJobStatus.RUNNING,
      stage: AnalysisJobStage.COLLECTING,
      progress: 10,
      userId: 7,
      repositoryId: 9,
      sourceCursor: new Date('2026-08-20T00:00:00.000Z'),
      reservedTokens: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      providerRequestIds: [],
      attemptCount: 1,
      maxAttempts: 5,
      nextPublishAt: null,
      leaseToken: 'lease-1',
      leaseExpiresAt: new Date('2026-08-26T00:15:00.000Z'),
      createdAt: new Date('2026-08-26T00:00:00.000Z'),
      completedAt: null,
      tokensSettledAt: null,
      repository: {
        githubRepoId: '11',
        fullName: 'owner/repo',
        owner: { username: 'developer' },
      },
      ...overrides,
    };
  }

  function createRecord(
    messageId: string,
    body = JSON.stringify({ schemaVersion: 1, jobId }),
    receiveCount = 1,
  ): SQSRecord {
    return {
      messageId,
      receiptHandle: `receipt-${messageId}`,
      body,
      attributes: {
        ApproximateReceiveCount: String(receiveCount),
        SentTimestamp: '0',
        SenderId: 'sender',
        ApproximateFirstReceiveTimestamp: '0',
      },
      messageAttributes: {
        traceId: {
          stringValue: 'trace-1',
          binaryValue: undefined,
          stringListValues: [],
          binaryListValues: [],
          dataType: 'String',
        },
      },
      md5OfBody: 'checksum',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:queue.fifo',
      awsRegion: 'us-east-1',
    };
  }
});
