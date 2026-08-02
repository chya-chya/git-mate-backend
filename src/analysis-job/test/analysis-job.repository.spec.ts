import { AnalysisJobStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
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
    });

    await repository.findRunningByLease('job-1', 'lease-1');

    expect(prisma.analysisJob.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: AnalysisJobStatus.RUNNING,
        leaseToken: 'lease-1',
      },
      select: { id: true, userId: true, repositoryId: true },
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
