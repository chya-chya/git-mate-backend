import { AnalysisJobStage, AnalysisJobStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AnalysisWorkerJob,
  AnalysisWorkerRepository,
  StaleAnalysisWorkerLeaseError,
} from '../analysis-worker.repository';

describe('AnalysisWorkerRepository', () => {
  const analysisJob = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  };
  const prisma = {
    analysisJob,
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  const repository = new AnalysisWorkerRepository(
    prisma as unknown as PrismaService,
  );
  const now = new Date('2026-08-26T00:00:00.000Z');
  const leaseExpiresAt = new Date('2026-08-26T00:15:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('atomically claims a due queued Job and reloads it by the new lease', async () => {
    const queued = createJob({ status: AnalysisJobStatus.QUEUED });
    const running = createJob({
      leaseToken: 'new-lease',
      leaseExpiresAt,
      attemptCount: 1,
    });
    analysisJob.findUnique.mockResolvedValue(queued);
    prisma.$queryRaw.mockResolvedValue([{ id: queued.id }]);
    analysisJob.findFirst.mockResolvedValue(running);

    await expect(
      repository.claim(queued.id, 'new-lease', now, leaseExpiresAt),
    ).resolves.toEqual({
      kind: 'CLAIMED',
      job: running,
      leaseToken: 'new-lease',
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(analysisJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: queued.id,
          status: AnalysisJobStatus.RUNNING,
          leaseToken: 'new-lease',
        },
      }),
    );
  });

  it('does not take over a RUNNING Job whose lease is still valid', async () => {
    analysisJob.findUnique.mockResolvedValue(
      createJob({ leaseExpiresAt: new Date('2026-08-26T00:01:00.000Z') }),
    );

    await expect(
      repository.claim('job-1', 'new-lease', now, leaseExpiresAt),
    ).resolves.toEqual({ kind: 'ACTIVE_LEASE' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('takes over an expired lease with a fenced conditional update', async () => {
    const expired = createJob({
      leaseToken: 'expired-lease',
      leaseExpiresAt: new Date('2026-08-25T23:59:00.000Z'),
      attemptCount: 1,
    });
    const replacement = createJob({
      leaseToken: 'new-lease',
      leaseExpiresAt,
      attemptCount: 2,
    });
    analysisJob.findUnique.mockResolvedValue(expired);
    prisma.$queryRaw.mockResolvedValue([{ id: expired.id }]);
    analysisJob.findFirst.mockResolvedValue(replacement);

    await expect(
      repository.claim(expired.id, 'new-lease', now, leaseExpiresAt),
    ).resolves.toMatchObject({
      kind: 'CLAIMED',
      job: { attemptCount: 2, leaseToken: 'new-lease' },
    });
  });

  it('acks terminal Jobs without attempting a claim', async () => {
    analysisJob.findUnique.mockResolvedValue(
      createJob({ status: AnalysisJobStatus.SUCCEEDED }),
    );

    await expect(
      repository.claim('job-1', 'new-lease', now, leaseExpiresAt),
    ).resolves.toEqual({ kind: 'TERMINAL' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects stale progress updates', async () => {
    analysisJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      repository.updateProgress({
        jobId: 'job-1',
        leaseToken: 'stale-lease',
        stage: AnalysisJobStage.SAVING,
        progress: 90,
        heartbeatAt: now,
        leaseExpiresAt,
      }),
    ).rejects.toBeInstanceOf(StaleAnalysisWorkerLeaseError);
    expect(analysisJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: AnalysisJobStatus.RUNNING,
        leaseToken: 'stale-lease',
        tokensSettledAt: null,
      },
      data: {
        stage: AnalysisJobStage.SAVING,
        progress: 90,
        heartbeatAt: now,
        leaseExpiresAt,
      },
    });
  });

  function createJob(
    overrides: Partial<AnalysisWorkerJob> = {},
  ): AnalysisWorkerJob {
    return {
      id: 'job-1',
      status: AnalysisJobStatus.RUNNING,
      stage: AnalysisJobStage.COLLECTING,
      progress: 10,
      userId: 7,
      repositoryId: 9,
      sourceCursor: null,
      reservedTokens: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      providerRequestIds: [],
      attemptCount: 0,
      maxAttempts: 5,
      nextPublishAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      createdAt: now,
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
});
