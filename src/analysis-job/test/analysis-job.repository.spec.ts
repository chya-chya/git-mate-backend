import { AnalysisJobStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ActiveAnalysisJobExistsError,
  AnalysisJobRepository,
  TransitionAnalysisJobRecordInput,
} from '../analysis-job.repository';

describe('AnalysisJobRepository', () => {
  const prisma = {
    analysisJob: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const repository = new AnalysisJobRepository(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('checks for an active Job under the repository advisory lock', async () => {
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      analysisJob: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const operation = jest.fn().mockResolvedValue('created');

    await expect(
      repository.createExclusive(9, operation, transaction as never),
    ).resolves.toBe('created');

    expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
    expect(transaction.analysisJob.findFirst).toHaveBeenCalledWith({
      where: {
        repositoryId: 9,
        status: {
          in: [AnalysisJobStatus.QUEUED, AnalysisJobStatus.RUNNING],
        },
      },
      select: { id: true },
    });
    expect(operation).toHaveBeenCalledWith(transaction);
  });

  it('rejects creation when the locked repository already has an active Job', async () => {
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      analysisJob: {
        findFirst: jest.fn().mockResolvedValue({ id: 'active-job' }),
      },
    };
    const operation = jest.fn();

    await expect(
      repository.createExclusive(9, operation, transaction as never),
    ).rejects.toBeInstanceOf(ActiveAnalysisJobExistsError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('guards success with the expected status, lease, and linked report', async () => {
    const transaction = {
      analysisJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };

    await expect(
      repository.transitionStatus(
        {
          jobId: 'job-1',
          fromStatus: AnalysisJobStatus.RUNNING,
          toStatus: AnalysisJobStatus.SUCCEEDED,
          expectedLeaseToken: 'lease-1',
          requiredReportId: 3,
          requiredUserId: 7,
          requiredRepositoryId: 9,
          requiredReservedTokens: 20,
          data: { progress: 100 },
        },
        transaction as never,
      ),
    ).resolves.toBe(true);

    expect(transaction.analysisJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: AnalysisJobStatus.RUNNING,
        leaseToken: 'lease-1',
        report: { is: { id: 3 } },
        userId: 7,
        repositoryId: 9,
        reservedTokens: 20,
        tokensSettledAt: null,
      },
      data: {
        progress: 100,
        status: AnalysisJobStatus.SUCCEEDED,
      },
    });
    expect(prisma.analysisJob.updateMany).not.toHaveBeenCalled();
  });

  it('loads worker ownership only when status and lease match', async () => {
    prisma.analysisJob.findFirst.mockResolvedValue({
      id: 'job-1',
      userId: 7,
      repositoryId: 9,
      modelVersion: 'gpt-5-mini',
      promptVersion: 'analysis-v1',
      reservedTokens: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      providerRequestIds: [],
    });

    await repository.findRunningByLease('job-1', 'lease-1');

    expect(prisma.analysisJob.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: AnalysisJobStatus.RUNNING,
        leaseToken: 'lease-1',
      },
      select: {
        id: true,
        userId: true,
        repositoryId: true,
        modelVersion: true,
        promptVersion: true,
        reservedTokens: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        providerRequestIds: true,
      },
    });
  });

  it('records a reservation only for the matching unsettled lease', async () => {
    prisma.analysisJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.reserveTokens({
        jobId: 'job-1',
        expectedLeaseToken: 'lease-1',
        expectedUserId: 7,
        expectedRepositoryId: 9,
        estimatedTokens: 10,
        reservedTokens: 20,
      }),
    ).resolves.toBe(true);

    expect(prisma.analysisJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: AnalysisJobStatus.RUNNING,
        leaseToken: 'lease-1',
        userId: 7,
        repositoryId: 9,
        reservedTokens: null,
        tokensSettledAt: null,
      },
      data: {
        stage: 'ANALYZING',
        estimatedTokens: 10,
        reservedTokens: 20,
      },
    });
  });

  it('checkpoints a provider charge only once for the matching lease', async () => {
    prisma.analysisJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.recordProviderCharge({
        jobId: 'job-1',
        expectedLeaseToken: 'lease-1',
        expectedUserId: 7,
        expectedRepositoryId: 9,
        expectedReservedTokens: 20,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        providerRequestId: 'chatcmpl_actual_123',
      }),
    ).resolves.toBe(true);

    expect(prisma.analysisJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: AnalysisJobStatus.RUNNING,
        leaseToken: 'lease-1',
        userId: 7,
        repositoryId: 9,
        reservedTokens: 20,
        tokensSettledAt: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        providerRequestIds: { isEmpty: true },
      },
      data: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        providerRequestIds: ['chatcmpl_actual_123'],
      },
    });
  });

  it('checkpoints a provider request when token usage is unknown', async () => {
    prisma.analysisJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.recordProviderCharge({
        jobId: 'job-1',
        expectedLeaseToken: 'lease-1',
        expectedUserId: 7,
        expectedRepositoryId: 9,
        expectedReservedTokens: 20,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        providerRequestId: 'chatcmpl_unknown_usage',
      }),
    ).resolves.toBe(true);

    expect(prisma.analysisJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: AnalysisJobStatus.RUNNING,
        leaseToken: 'lease-1',
        userId: 7,
        repositoryId: 9,
        reservedTokens: 20,
        tokensSettledAt: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        providerRequestIds: { isEmpty: true },
      },
      data: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        providerRequestIds: ['chatcmpl_unknown_usage'],
      },
    });
  });

  it('reports a stale transition when no row matches the guard', async () => {
    prisma.analysisJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      repository.transitionStatus({
        jobId: 'job-1',
        fromStatus: AnalysisJobStatus.QUEUED,
        toStatus: AnalysisJobStatus.RUNNING,
        data: {
          leaseToken: 'lease-1',
          leaseExpiresAt: new Date('2026-07-22T01:05:00.000Z'),
        },
      }),
    ).resolves.toBe(false);
  });

  it('rejects a RUNNING update without a lease before accessing storage', async () => {
    const unsafeInput = {
      jobId: 'job-1',
      fromStatus: AnalysisJobStatus.RUNNING,
      toStatus: AnalysisJobStatus.FAILED,
      data: {},
    } as unknown as TransitionAnalysisJobRecordInput;

    await expect(repository.transitionStatus(unsafeInput)).rejects.toThrow(
      'A lease fence is required',
    );
    expect(prisma.analysisJob.updateMany).not.toHaveBeenCalled();
  });

  it('rejects success without a linked report fence', async () => {
    const unsafeInput = {
      jobId: 'job-1',
      fromStatus: AnalysisJobStatus.RUNNING,
      toStatus: AnalysisJobStatus.SUCCEEDED,
      expectedLeaseToken: 'lease-1',
      data: { progress: 100 },
    } as unknown as TransitionAnalysisJobRecordInput;

    await expect(repository.transitionStatus(unsafeInput)).rejects.toThrow(
      'A linked report, user, and repository are required',
    );
    expect(prisma.analysisJob.updateMany).not.toHaveBeenCalled();
  });
});
