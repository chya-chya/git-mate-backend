import { ConfigService } from '@nestjs/config';
import { AnalysisJobStatus } from '@prisma/client';
import {
  AnalysisJobPublishRecord,
  AnalysisJobPublishRepository,
} from '../analysis-job-publish.repository';
import {
  AnalysisJobPublishOutcome,
  AnalysisJobPublisherService,
} from '../analysis-job-publisher.service';
import { AnalysisJobQueueConfig } from '../queue/analysis-job-queue.config';
import { AnalysisJobQueue } from '../queue/analysis-job.queue';

const NOW = new Date('2026-08-25T00:00:00.000Z');

function createJob(
  overrides: Partial<AnalysisJobPublishRecord> = {},
): AnalysisJobPublishRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: AnalysisJobStatus.QUEUED,
    userId: 7,
    repositoryId: 17,
    idempotencyKey: 'api-request-1',
    reservedTokens: null,
    publishAttempts: 0,
    messagePublishedAt: null,
    nextPublishAt: null,
    lastErrorCode: null,
    createdAt: new Date('2026-08-24T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AnalysisJobPublisherService', () => {
  const repository = {
    claimAttempt: jest.fn().mockResolvedValue(true),
    markPublished: jest.fn().mockResolvedValue(true),
    recordFailure: jest.fn().mockResolvedValue(true),
  };
  const queue = {
    publish: jest.fn().mockResolvedValue({ messageId: 'message-1' }),
  };

  function createService(maxAttempts = 5): AnalysisJobPublisherService {
    const config = new AnalysisJobQueueConfig(
      new ConfigService({
        AWS_REGION: 'us-east-1',
        ANALYSIS_JOB_QUEUE_URL:
          'http://127.0.0.1:4566/000000000000/analysis-jobs.fifo',
        ANALYSIS_JOB_PUBLISH_MAX_ATTEMPTS: String(maxAttempts),
        ANALYSIS_JOB_REPUBLISH_AFTER_SECONDS: '60',
      }),
    );
    return new AnalysisJobPublisherService(
      repository as unknown as AnalysisJobPublishRepository,
      queue as AnalysisJobQueue,
      config,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    repository.claimAttempt.mockResolvedValue(true);
    repository.markPublished.mockResolvedValue(true);
    repository.recordFailure.mockResolvedValue(true);
    queue.publish.mockResolvedValue({ messageId: 'message-1' });
  });

  it('publishes after the durable Job is available and records success', async () => {
    const service = createService();
    const job = createJob();

    await expect(
      service.publish(job, {
        allowRepublish: false,
        now: NOW,
        traceId: 'trace-1',
      }),
    ).resolves.toBe(AnalysisJobPublishOutcome.PUBLISHED);

    expect(repository.claimAttempt).toHaveBeenCalledWith({
      job,
      claimedNextPublishAt: new Date('2026-08-25T00:01:00.000Z'),
      deliveryUncertain: false,
    });
    expect(queue.publish).toHaveBeenCalledWith({
      jobId: job.id,
      userId: 7,
      repositoryId: 17,
      traceId: 'trace-1',
    });
    expect(repository.markPublished).toHaveBeenCalledWith(
      {
        job,
        attempt: 1,
        claimedNextPublishAt: new Date('2026-08-25T00:01:00.000Z'),
      },
      NOW,
    );
  });

  it('defers a confirmed SQS failure with exponential bounded jitter', async () => {
    queue.publish.mockRejectedValueOnce(new Error('connection refused'));
    const service = createService();
    const job = createJob({ publishAttempts: 1 });

    await expect(
      service.publish(job, {
        allowRepublish: false,
        now: NOW,
        traceId: 'trace-2',
        random: 0.5,
      }),
    ).resolves.toBe(AnalysisJobPublishOutcome.DEFERRED);

    expect(repository.recordFailure).toHaveBeenCalledWith({
      job,
      attempt: 2,
      claimedNextPublishAt: new Date('2026-08-25T00:01:00.000Z'),
      nextPublishAt: new Date('2026-08-25T00:02:12.000Z'),
      deliveryUncertain: false,
      terminate: false,
      completedAt: NOW,
    });
  });

  it('does not falsely fail a Job when SQS succeeds but DB acknowledgement loses the CAS', async () => {
    repository.markPublished.mockResolvedValueOnce(false);
    const service = createService();

    await expect(
      service.publish(createJob(), {
        allowRepublish: false,
        now: NOW,
        traceId: 'trace-3',
      }),
    ).resolves.toBe(AnalysisJobPublishOutcome.DEFERRED);

    expect(repository.recordFailure).not.toHaveBeenCalled();
  });

  it('terminates only a fully unsettled Job after the maximum confirmed failure', async () => {
    queue.publish.mockRejectedValueOnce(new Error('unavailable'));
    const service = createService(2);
    const job = createJob({
      publishAttempts: 1,
      lastErrorCode: 'PUBLISH_ATTEMPT_FAILED',
    });

    await expect(
      service.publish(job, {
        allowRepublish: false,
        now: NOW,
        traceId: 'trace-4',
        random: 0,
      }),
    ).resolves.toBe(AnalysisJobPublishOutcome.FAILED);

    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ terminate: true }),
    );
  });

  it.each([
    createJob({
      publishAttempts: 1,
      lastErrorCode: 'PUBLISH_DELIVERY_UNCERTAIN',
    }),
    createJob({
      publishAttempts: 1,
      messagePublishedAt: new Date('2026-08-24T23:00:00.000Z'),
    }),
    createJob({ publishAttempts: 1, reservedTokens: 100 }),
  ])(
    'does not terminate a Job with uncertain delivery or reserved tokens',
    async (job) => {
      queue.publish.mockRejectedValueOnce(new Error('unavailable'));
      const service = createService(2);

      await expect(
        service.publish(job, {
          allowRepublish: true,
          now: NOW,
          traceId: 'trace-5',
          random: 0,
        }),
      ).resolves.toBe(AnalysisJobPublishOutcome.DEFERRED);
      expect(repository.recordFailure).toHaveBeenCalledWith(
        expect.objectContaining({ terminate: false }),
      );
    },
  );

  it('does not republish an acknowledged Job on an idempotent API replay', async () => {
    const service = createService();

    await expect(
      service.publishAcceptedJob(
        createJob({ messagePublishedAt: new Date('2026-08-24T00:00:00.000Z') }),
      ),
    ).resolves.toBe(AnalysisJobPublishOutcome.SKIPPED);
    expect(repository.claimAttempt).not.toHaveBeenCalled();
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('never publishes a synchronous Job', async () => {
    const service = createService();

    await expect(
      service.publishAcceptedJob(createJob({ idempotencyKey: 'sync:job-1' })),
    ).resolves.toBe(AnalysisJobPublishOutcome.SKIPPED);
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('does not count a configuration error as an SQS attempt', async () => {
    const config = new AnalysisJobQueueConfig(new ConfigService({}));
    const service = new AnalysisJobPublisherService(
      repository as unknown as AnalysisJobPublishRepository,
      queue as AnalysisJobQueue,
      config,
    );

    await expect(service.publishAcceptedJob(createJob())).resolves.toBe(
      AnalysisJobPublishOutcome.DEFERRED,
    );
    expect(repository.claimAttempt).not.toHaveBeenCalled();
    expect(queue.publish).not.toHaveBeenCalled();
  });
});
