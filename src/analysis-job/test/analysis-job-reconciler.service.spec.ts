import { ConfigService } from '@nestjs/config';
import {
  AnalysisJobPublishRecord,
  AnalysisJobPublishRepository,
} from '../analysis-job-publish.repository';
import {
  AnalysisJobPublishOutcome,
  AnalysisJobPublisherService,
} from '../analysis-job-publisher.service';
import { AnalysisJobReconcilerService } from '../analysis-job-reconciler.service';
import { AnalysisJobQueueConfig } from '../queue/analysis-job-queue.config';
import { AnalysisJobStatus } from '@prisma/client';

function createJob(id: string): AnalysisJobPublishRecord {
  return {
    id,
    status: AnalysisJobStatus.QUEUED,
    userId: 7,
    repositoryId: 17,
    idempotencyKey: `request-${id}`,
    reservedTokens: null,
    publishAttempts: 0,
    messagePublishedAt: null,
    nextPublishAt: null,
    lastErrorCode: null,
    createdAt: new Date('2026-08-24T00:00:00.000Z'),
  };
}

describe('AnalysisJobReconcilerService', () => {
  it('processes each due Job independently and returns an operational summary', async () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    const jobs = [
      createJob('11111111-1111-4111-8111-111111111111'),
      createJob('22222222-2222-4222-8222-222222222222'),
      createJob('33333333-3333-4333-8333-333333333333'),
      createJob('44444444-4444-4444-8444-444444444444'),
    ];
    const repository = {
      findDue: jest.fn().mockResolvedValue(jobs),
    };
    const publisher = {
      publish: jest
        .fn()
        .mockResolvedValueOnce(AnalysisJobPublishOutcome.PUBLISHED)
        .mockRejectedValueOnce(new Error('unexpected item failure'))
        .mockResolvedValueOnce(AnalysisJobPublishOutcome.DEFERRED)
        .mockResolvedValueOnce(AnalysisJobPublishOutcome.FAILED),
    };
    const config = new AnalysisJobQueueConfig(
      new ConfigService({
        ANALYSIS_JOB_PUBLISH_MAX_ATTEMPTS: '5',
        ANALYSIS_JOB_REPUBLISH_AFTER_SECONDS: '60',
        ANALYSIS_JOB_RECONCILE_BATCH_SIZE: '20',
      }),
    );
    const service = new AnalysisJobReconcilerService(
      repository as unknown as AnalysisJobPublishRepository,
      publisher as unknown as AnalysisJobPublisherService,
      config,
    );

    await expect(service.runOnce(now)).resolves.toEqual({
      scanned: 4,
      published: 1,
      deferred: 2,
      failed: 1,
    });
    expect(repository.findDue).toHaveBeenCalledWith(now, 60, 5, 20);
    expect(publisher.publish).toHaveBeenCalledTimes(4);
  });
});
