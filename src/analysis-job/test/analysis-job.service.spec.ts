import { AnalysisJobStatus } from '@prisma/client';
import { AnalysisJobRepository } from '../analysis-job.repository';
import {
  AnalysisJobService,
  InvalidAnalysisJobTransitionError,
  StaleAnalysisJobTransitionError,
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

  it.each([
    [AnalysisJobStatus.QUEUED, AnalysisJobStatus.SUCCEEDED],
    [AnalysisJobStatus.SUCCEEDED, AnalysisJobStatus.RUNNING],
    [AnalysisJobStatus.FAILED, AnalysisJobStatus.QUEUED],
  ])('rejects %s to %s', async (fromStatus, toStatus) => {
    await expect(
      service.transition({ jobId: 'job-1', fromStatus, toStatus }),
    ).rejects.toBeInstanceOf(InvalidAnalysisJobTransitionError);
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('persists an allowed transition with a lease fence', async () => {
    repository.transitionStatus.mockResolvedValue(true);

    await service.transition({
      jobId: 'job-1',
      fromStatus: AnalysisJobStatus.RUNNING,
      toStatus: AnalysisJobStatus.SUCCEEDED,
      expectedLeaseToken: 'lease-1',
      data: { progress: 100 },
    });

    expect(repository.transitionStatus).toHaveBeenCalledWith({
      jobId: 'job-1',
      fromStatus: AnalysisJobStatus.RUNNING,
      toStatus: AnalysisJobStatus.SUCCEEDED,
      expectedLeaseToken: 'lease-1',
      data: { progress: 100 },
    });
  });

  it('rejects a stale compare-and-set transition', async () => {
    repository.transitionStatus.mockResolvedValue(false);

    await expect(
      service.transition({
        jobId: 'job-1',
        fromStatus: AnalysisJobStatus.QUEUED,
        toStatus: AnalysisJobStatus.RUNNING,
      }),
    ).rejects.toBeInstanceOf(StaleAnalysisJobTransitionError);
  });
});
