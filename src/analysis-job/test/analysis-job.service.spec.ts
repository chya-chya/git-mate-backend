import { AnalysisJobStatus } from '@prisma/client';
import {
  AnalysisJobDatabase,
  AnalysisJobRepository,
  TransitionAnalysisJobRecordInput,
} from '../analysis-job.repository';
import {
  AnalysisJobFailureCode,
  AnalysisJobService,
  InvalidAnalysisJobInputError,
  InvalidAnalysisJobTransitionError,
  StaleAnalysisJobTransitionError,
  TransitionAnalysisJobInput,
  canTransitionAnalysisJob,
} from '../analysis-job.service';

describe('AnalysisJobService', () => {
  const repository = {
    create: jest.fn(),
    findById: jest.fn(),
    transitionStatus: jest.fn(),
  };
  const service = new AnalysisJobService(
    repository as unknown as AnalysisJobRepository,
  );
  const completedAt = new Date('2026-07-22T01:00:00.000Z');
  const tokensSettledAt = new Date('2026-07-22T01:00:01.000Z');
  const settlement = {
    completedAt,
    tokensSettledAt,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    providerRequestIds: ['req_123'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    [AnalysisJobStatus.QUEUED, AnalysisJobStatus.RUNNING],
    [AnalysisJobStatus.QUEUED, AnalysisJobStatus.FAILED],
    [AnalysisJobStatus.RUNNING, AnalysisJobStatus.QUEUED],
    [AnalysisJobStatus.RUNNING, AnalysisJobStatus.SUCCEEDED],
    [AnalysisJobStatus.RUNNING, AnalysisJobStatus.FAILED],
  ])('allows %s to transition to %s', (fromStatus, toStatus) => {
    expect(canTransitionAnalysisJob(fromStatus, toStatus)).toBe(true);
  });

  it('creates the request hash on the server from canonical fields', async () => {
    repository.create.mockResolvedValue({});
    const input = {
      userId: 7,
      repositoryId: 9,
      idempotencyKey: 'analysis-1',
      modelVersion: 'gpt-5.1',
      promptVersion: 'v2',
      sourceCursor: new Date('2026-07-22T00:00:00.000Z'),
    };

    await service.create(input);
    await service.create(input);

    const createCalls = repository.create.mock.calls as unknown as Array<
      [{ requestHash: string }]
    >;
    const firstRecord = createCalls[0][0];
    const secondRecord = createCalls[1][0];
    expect(firstRecord.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(secondRecord.requestHash).toBe(firstRecord.requestHash);
  });

  it('rejects an invalid status transition', async () => {
    const input = {
      jobId: 'job-1',
      fromStatus: AnalysisJobStatus.QUEUED,
      toStatus: AnalysisJobStatus.SUCCEEDED,
      data: settlement,
    } as unknown as TransitionAnalysisJobInput;

    await expect(service.transition(input)).rejects.toBeInstanceOf(
      InvalidAnalysisJobTransitionError,
    );
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('requires a lease fence at runtime for every RUNNING transition', async () => {
    const input = {
      jobId: 'job-1',
      fromStatus: AnalysisJobStatus.RUNNING,
      toStatus: AnalysisJobStatus.SUCCEEDED,
      data: { ...settlement, reportId: 3 },
    } as unknown as TransitionAnalysisJobInput;

    await expect(service.transition(input)).rejects.toThrow(
      'expectedLeaseToken is required',
    );
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('persists a successful terminal transition with its lease and report fences', async () => {
    repository.transitionStatus.mockResolvedValue(true);
    const database = { analysisJob: {} } as unknown as AnalysisJobDatabase;

    await service.transition(
      {
        jobId: 'job-1',
        fromStatus: AnalysisJobStatus.RUNNING,
        toStatus: AnalysisJobStatus.SUCCEEDED,
        expectedLeaseToken: 'lease-1',
        data: { ...settlement, reportId: 3 },
      },
      database,
    );

    expect(repository.transitionStatus).toHaveBeenCalledWith(
      {
        jobId: 'job-1',
        fromStatus: AnalysisJobStatus.RUNNING,
        toStatus: AnalysisJobStatus.SUCCEEDED,
        expectedLeaseToken: 'lease-1',
        requiredReportId: 3,
        data: {
          stage: null,
          progress: 100,
          ...settlement,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      },
      database,
    );
  });

  it('rejects a terminal transition without complete token settlement', async () => {
    const input = {
      jobId: 'job-1',
      fromStatus: AnalysisJobStatus.RUNNING,
      toStatus: AnalysisJobStatus.FAILED,
      expectedLeaseToken: 'lease-1',
      data: {
        completedAt,
        tokensSettledAt,
        promptTokens: 10,
        completionTokens: 5,
        providerRequestIds: [],
        errorCode: AnalysisJobFailureCode.ANALYSIS_FAILED,
        errorRetryable: false,
      },
    } as unknown as TransitionAnalysisJobInput;

    await expect(service.transition(input)).rejects.toBeInstanceOf(
      InvalidAnalysisJobInputError,
    );
  });

  it('rejects provider identifiers that could contain raw payloads', async () => {
    const input = {
      jobId: 'job-1',
      fromStatus: AnalysisJobStatus.QUEUED,
      toStatus: AnalysisJobStatus.FAILED,
      data: {
        ...settlement,
        providerRequestIds: ['prompt contents must not be stored'],
        errorCode: AnalysisJobFailureCode.ANALYSIS_FAILED,
        errorRetryable: false,
      },
    } satisfies TransitionAnalysisJobInput;

    await expect(service.transition(input)).rejects.toThrow(
      'providerRequestIds is invalid',
    );
  });

  it('stores only the server-owned safe message for failures', async () => {
    repository.transitionStatus.mockResolvedValue(true);

    await service.transition({
      jobId: 'job-1',
      fromStatus: AnalysisJobStatus.RUNNING,
      toStatus: AnalysisJobStatus.FAILED,
      expectedLeaseToken: 'lease-1',
      data: {
        ...settlement,
        errorCode: AnalysisJobFailureCode.ANALYSIS_FAILED,
        errorRetryable: false,
      },
    });

    const transitionCalls = repository.transitionStatus.mock
      .calls as unknown as Array<[TransitionAnalysisJobRecordInput]>;
    expect(transitionCalls[0][0].data.lastErrorCode).toBe('ANALYSIS_FAILED');
    expect(transitionCalls[0][0].data.lastErrorMessage).toBe(
      'Analysis failed.',
    );
  });

  it('rejects a stale compare-and-set transition', async () => {
    repository.transitionStatus.mockResolvedValue(false);

    await expect(
      service.transition({
        jobId: 'job-1',
        fromStatus: AnalysisJobStatus.QUEUED,
        toStatus: AnalysisJobStatus.RUNNING,
        data: {
          leaseToken: 'lease-1',
          leaseExpiresAt: new Date('2026-07-22T01:05:00.000Z'),
          startedAt: new Date('2026-07-22T01:00:00.000Z'),
        },
      }),
    ).rejects.toBeInstanceOf(StaleAnalysisJobTransitionError);
  });
});
