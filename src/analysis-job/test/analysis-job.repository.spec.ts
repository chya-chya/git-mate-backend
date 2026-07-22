import { AnalysisJobStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AnalysisJobRepository,
  TransitionAnalysisJobRecordInput,
} from '../analysis-job.repository';

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

  it('guards success with the expected status, lease, and linked report', async () => {
    prisma.analysisJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.transitionStatus({
        jobId: 'job-1',
        fromStatus: AnalysisJobStatus.RUNNING,
        toStatus: AnalysisJobStatus.SUCCEEDED,
        expectedLeaseToken: 'lease-1',
        requiredReportId: 3,
        data: { progress: 100 },
      }),
    ).resolves.toBe(true);

    expect(prisma.analysisJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: AnalysisJobStatus.RUNNING,
        leaseToken: 'lease-1',
        report: { is: { id: 3 } },
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
      'A linked report is required',
    );
    expect(prisma.analysisJob.updateMany).not.toHaveBeenCalled();
  });
});
