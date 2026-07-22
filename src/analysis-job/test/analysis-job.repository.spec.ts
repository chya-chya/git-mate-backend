import { AnalysisJobStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalysisJobRepository } from '../analysis-job.repository';

describe('AnalysisJobRepository', () => {
  const prisma = {
    analysisJob: {
      updateMany: jest.fn(),
    },
  };
  const repository = new AnalysisJobRepository(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('guards a transition with the expected status and lease token', async () => {
    prisma.analysisJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.transitionStatus({
        jobId: 'job-1',
        fromStatus: AnalysisJobStatus.RUNNING,
        toStatus: AnalysisJobStatus.SUCCEEDED,
        expectedLeaseToken: 'lease-1',
        data: { progress: 100 },
      }),
    ).resolves.toBe(true);

    expect(prisma.analysisJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: AnalysisJobStatus.RUNNING,
        leaseToken: 'lease-1',
      },
      data: {
        progress: 100,
        status: AnalysisJobStatus.SUCCEEDED,
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
      }),
    ).resolves.toBe(false);
  });
});
