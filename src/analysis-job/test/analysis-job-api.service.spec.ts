import { createHash } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { AnalysisJobStage, AnalysisJobStatus } from '@prisma/client';
import { AnalysisJobApiRepository } from '../analysis-job-api.repository';
import { AnalysisJobApiService } from '../analysis-job-api.service';
import { AnalysisJobApiRecord } from '../analysis-job-api.types';
import { AnalysisJobResponseMapper } from '../analysis-job-response.mapper';
import {
  ActiveAnalysisJobExistsError,
  AnalysisJobRepository,
} from '../analysis-job.repository';
import {
  AnalysisJobPublishOutcome,
  AnalysisJobPublisherService,
} from '../analysis-job-publisher.service';

const FIRST_JOB_ID = '11111111-1111-4111-8111-111111111111';
const RETRY_JOB_ID = '22222222-2222-4222-8222-222222222222';

async function expectApiError(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected API error ${expectedCode}`);
  } catch (error) {
    if (!(error instanceof HttpException)) {
      throw error;
    }
    const response = error.getResponse();
    if (typeof response !== 'object' || response === null) {
      throw new Error('Expected a structured API error');
    }
    expect((response as Record<string, unknown>).code).toBe(expectedCode);
  }
}

function createJob(
  overrides: Partial<AnalysisJobApiRecord> = {},
): AnalysisJobApiRecord {
  return {
    id: FIRST_JOB_ID,
    status: AnalysisJobStatus.QUEUED,
    stage: AnalysisJobStage.WAITING,
    progress: 0,
    userId: 7,
    repositoryId: 17,
    idempotencyKey: 'request-1',
    requestHash: 'a'.repeat(64),
    sourceCursor: null,
    modelVersion: 'gpt-5-mini',
    promptVersion: 'analysis-v1',
    estimatedTokens: null,
    reservedTokens: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    tokensSettledAt: null,
    providerRequestIds: [],
    publishAttempts: 0,
    messagePublishedAt: null,
    nextPublishAt: null,
    attemptCount: 0,
    maxAttempts: 5,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    errorRetryable: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-08-16T00:00:00.000Z'),
    updatedAt: new Date('2026-08-16T00:00:00.000Z'),
    repository: {
      id: 17,
      githubRepoId: '123456789',
      fullName: 'octocat/example',
    },
    report: null,
    ...overrides,
  };
}

describe('AnalysisJobApiService', () => {
  const database = {};
  let storedJob: AnalysisJobApiRecord | null;
  const repository = {
    transaction: jest.fn(
      (operation: (transaction: object) => Promise<AnalysisJobApiRecord>) =>
        operation(database),
    ),
    acquireTransactionLock: jest.fn().mockResolvedValue(undefined),
    getCreationRateLimitStatus: jest.fn().mockResolvedValue({
      totalHits: 0,
      remaining: 5,
      retryAfterSeconds: 60,
      isBlocked: false,
    }),
    findByIdempotencyKey: jest.fn(() => Promise.resolve(storedJob)),
    findOwnedRepositoryByGithubId: jest.fn(
      (_userId: number, githubRepoId: string) =>
        Promise.resolve({
          id: githubRepoId === '987654321' ? 18 : 17,
          githubRepoId,
          fullName: `octocat/${githubRepoId}`,
          lastSyncTime: null,
          owner: { availableTokens: 1000 },
        }),
    ),
    create: jest.fn(
      (input: {
        userId: number;
        repositoryId: number;
        idempotencyKey: string;
        requestHash: string;
      }) => {
        storedJob = createJob({
          userId: input.userId,
          repositoryId: input.repositoryId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          repository: {
            id: input.repositoryId,
            githubRepoId: input.repositoryId === 18 ? '987654321' : '123456789',
            fullName: 'octocat/example',
          },
        });
        return Promise.resolve(storedJob);
      },
    ),
    findOwnedById: jest.fn(),
    listOwned: jest.fn(),
  };
  const creationRepository = {
    createExclusive: jest.fn(
      (
        _repositoryId: number,
        operation: (transaction: object) => Promise<AnalysisJobApiRecord>,
      ) => operation(database),
    ),
  };
  const publisher = {
    publishAcceptedJob: jest
      .fn()
      .mockResolvedValue(AnalysisJobPublishOutcome.PUBLISHED),
  };
  const service = new AnalysisJobApiService(
    repository as unknown as AnalysisJobApiRepository,
    new AnalysisJobResponseMapper(),
    creationRepository as unknown as AnalysisJobRepository,
    publisher as unknown as AnalysisJobPublisherService,
  );

  beforeEach(() => {
    storedJob = null;
    jest.clearAllMocks();
    repository.acquireTransactionLock.mockResolvedValue(undefined);
    publisher.publishAcceptedJob.mockResolvedValue(
      AnalysisJobPublishOutcome.PUBLISHED,
    );
    repository.getCreationRateLimitStatus.mockResolvedValue({
      totalHits: 0,
      remaining: 5,
      retryAfterSeconds: 60,
      isBlocked: false,
    });
    repository.findByIdempotencyKey.mockImplementation(() =>
      Promise.resolve(storedJob),
    );
    creationRepository.createExclusive.mockImplementation(
      (
        _repositoryId: number,
        operation: (transaction: object) => Promise<AnalysisJobApiRecord>,
      ) => operation(database),
    );
  });

  it('returns the same Job for the same user, key, and request', async () => {
    const first = await service.create(7, '123456789', 'request-1');
    const repeated = await service.create(7, '123456789', 'request-1');

    expect(repeated.job.jobId).toBe(first.job.jobId);
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(publisher.publishAcceptedJob).toHaveBeenCalledTimes(2);
    expect(repository.acquireTransactionLock).toHaveBeenNthCalledWith(
      1,
      'analysis-job-idempotency:7:request-1',
      database,
    );
    expect(repository.acquireTransactionLock).toHaveBeenNthCalledWith(
      2,
      'analysis-job-rate-limit:7',
      database,
    );
  });

  it('hashes only stable client request fields', async () => {
    await service.create(7, '123456789', 'request-1');

    const expectedHash = createHash('sha256')
      .update(
        JSON.stringify({
          userId: 7,
          request: { type: 'CREATE', githubRepoId: '123456789' },
        }),
      )
      .digest('hex');

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ requestHash: expectedHash }),
      database,
    );
  });

  it('returns the post-creation rate-limit status', async () => {
    repository.getCreationRateLimitStatus
      .mockResolvedValueOnce({
        totalHits: 4,
        remaining: 1,
        retryAfterSeconds: 30,
        isBlocked: false,
      })
      .mockResolvedValueOnce({
        totalHits: 5,
        remaining: 0,
        retryAfterSeconds: 29,
        isBlocked: true,
      });

    await expect(
      service.create(7, '123456789', 'request-1'),
    ).resolves.toMatchObject({
      rateLimit: {
        totalHits: 5,
        remaining: 0,
        retryAfterSeconds: 29,
        isBlocked: true,
      },
    });
    expect(repository.getCreationRateLimitStatus).toHaveBeenCalledTimes(2);
  });

  it('rejects reuse of the same key for a different repository', async () => {
    await service.create(7, '123456789', 'request-1');

    await expectApiError(
      service.create(7, '987654321', 'request-1'),
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(repository.create).toHaveBeenCalledTimes(1);
  });

  it('checks an identical request before the active Job limit', async () => {
    const first = await service.create(7, '123456789', 'request-1');

    await expect(
      service.create(7, '123456789', 'request-1'),
    ).resolves.toMatchObject({ job: { jobId: first.job.jobId } });
    expect(creationRepository.createExclusive).toHaveBeenCalledTimes(1);
  });

  it('returns an identical request even when the creation limit is full', async () => {
    const first = await service.create(7, '123456789', 'request-1');
    repository.getCreationRateLimitStatus.mockClear();
    repository.getCreationRateLimitStatus.mockResolvedValue({
      totalHits: 5,
      remaining: 0,
      retryAfterSeconds: 18,
      isBlocked: true,
    });

    const repeated = await service.create(7, '123456789', 'request-1');

    expect(repeated).toMatchObject({
      job: { jobId: first.job.jobId },
      rateLimit: { remaining: 0, isBlocked: true },
    });
    expect(repository.getCreationRateLimitStatus).toHaveBeenCalledWith(
      7,
      database,
    );
  });

  it('blocks a new key when the repository already has an active Job', async () => {
    creationRepository.createExclusive.mockRejectedValueOnce(
      new ActiveAnalysisJobExistsError(17),
    );

    await expectApiError(
      service.create(7, '123456789', 'request-2'),
      'ACTIVE_JOB_EXISTS',
    );
    expect(repository.create).not.toHaveBeenCalled();
    expect(publisher.publishAcceptedJob).not.toHaveBeenCalled();
  });

  it('keeps the accepted response when queue publication is deferred', async () => {
    publisher.publishAcceptedJob.mockResolvedValueOnce(
      AnalysisJobPublishOutcome.DEFERRED,
    );

    await expect(
      service.create(7, '123456789', 'request-1'),
    ).resolves.toMatchObject({
      job: { jobId: FIRST_JOB_ID, status: AnalysisJobStatus.QUEUED },
    });
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(publisher.publishAcceptedJob).toHaveBeenCalledTimes(1);
    expect(repository.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      publisher.publishAcceptedJob.mock.invocationCallOrder[0],
    );
  });

  it('blocks a sixth Job under the transaction-scoped user limit', async () => {
    repository.getCreationRateLimitStatus.mockResolvedValueOnce({
      totalHits: 5,
      remaining: 0,
      retryAfterSeconds: 18,
      isBlocked: true,
    });

    await expectApiError(
      service.create(7, '123456789', 'request-6'),
      'RATE_LIMITED',
    );
    expect(repository.findOwnedRepositoryByGithubId).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('re-reads an idempotent winner after a unique conflict', async () => {
    const first = await service.create(7, '123456789', 'request-1');
    repository.transaction.mockRejectedValueOnce({ code: 'P2002' });

    await expect(
      service.create(7, '123456789', 'request-1'),
    ).resolves.toMatchObject({ job: { jobId: first.job.jobId } });
  });

  it('creates a retry as a new Job without mutating the source', async () => {
    const source = createJob({
      id: FIRST_JOB_ID,
      status: AnalysisJobStatus.FAILED,
      stage: null,
      errorRetryable: true,
      lastErrorCode: 'ANALYSIS_FAILED',
      completedAt: new Date('2026-08-16T00:01:00.000Z'),
    });
    repository.findOwnedById.mockResolvedValue(source);
    repository.create.mockImplementationOnce(
      (input: { idempotencyKey: string; requestHash: string }) => {
        storedJob = createJob({
          id: RETRY_JOB_ID,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        });
        return Promise.resolve(storedJob);
      },
    );

    const retried = await service.retry(7, FIRST_JOB_ID, 'retry-1');

    expect(retried.job.jobId).toBe(RETRY_JOB_ID);
    expect(source.status).toBe(AnalysisJobStatus.FAILED);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        repositoryId: 17,
        idempotencyKey: 'retry-1',
      }),
      database,
    );
  });

  it('hides another user or missing source Job as JOB_NOT_FOUND', async () => {
    repository.findOwnedById.mockResolvedValue(null);

    await expect(
      service.retry(8, FIRST_JOB_ID, 'retry-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects a non-retryable failed Job', async () => {
    repository.findOwnedById.mockResolvedValue(
      createJob({ status: AnalysisJobStatus.FAILED, errorRetryable: false }),
    );

    await expect(
      service.retry(7, FIRST_JOB_ID, 'retry-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists only through a user-scoped repository query', async () => {
    repository.listOwned.mockResolvedValue([createJob()]);

    const result = await service.list(7, {
      repositoryId: 17,
      status: AnalysisJobStatus.QUEUED,
      limit: 20,
    });

    expect(result.items).toHaveLength(1);
    expect(repository.listOwned).toHaveBeenCalledWith({
      userId: 7,
      repositoryId: 17,
      status: AnalysisJobStatus.QUEUED,
      limit: 20,
      cursor: undefined,
    });
  });

  it('rejects a malformed cursor without querying storage', async () => {
    await expect(
      service.list(7, { limit: 20, cursor: 'bm90LWpzb24' }),
    ).rejects.toMatchObject({
      response: { code: 'INVALID_REQUEST', message: 'Cursor is invalid.' },
    });
    expect(repository.listOwned).not.toHaveBeenCalled();
  });
});
