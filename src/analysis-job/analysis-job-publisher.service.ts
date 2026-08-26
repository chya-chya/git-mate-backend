import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AnalysisJobStatus } from '@prisma/client';
import {
  AnalysisJobPublishRecord,
  AnalysisJobPublishRepository,
} from './analysis-job-publish.repository';
import {
  AnalysisJobQueueConfig,
  AnalysisJobQueueConfigurationError,
} from './queue/analysis-job-queue.config';
import {
  ANALYSIS_JOB_QUEUE,
  AnalysisJobQueueRejectedError,
} from './queue/analysis-job.queue';
import type { AnalysisJobQueue } from './queue/analysis-job.queue';

const INTERNAL_UNCERTAIN_PUBLISH_CODES = new Set([
  'PUBLISH_IN_PROGRESS',
  'PUBLISH_DELIVERY_UNCERTAIN',
]);
const MAX_BACKOFF_SECONDS = 3_600;
const JITTER_RATIO = 0.2;

export enum AnalysisJobPublishOutcome {
  PUBLISHED = 'PUBLISHED',
  DEFERRED = 'DEFERRED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

export interface PublishAnalysisJobOptions {
  allowRepublish: boolean;
  now?: Date;
  traceId?: string;
  random?: number;
}

@Injectable()
export class AnalysisJobPublisherService {
  private readonly logger = new Logger(AnalysisJobPublisherService.name);

  constructor(
    private readonly repository: AnalysisJobPublishRepository,
    @Inject(ANALYSIS_JOB_QUEUE)
    private readonly queue: AnalysisJobQueue,
    private readonly config: AnalysisJobQueueConfig,
  ) {}

  async publishAcceptedJob(
    job: AnalysisJobPublishRecord,
  ): Promise<AnalysisJobPublishOutcome> {
    return this.publish(job, { allowRepublish: false });
  }

  async publish(
    job: AnalysisJobPublishRecord,
    options: PublishAnalysisJobOptions,
  ): Promise<AnalysisJobPublishOutcome> {
    const now = options.now ?? new Date();
    const traceId = options.traceId ?? randomUUID();

    try {
      const settings = this.config.getPublishSettings();
      if (!this.isDue(job, now, settings.republishAfterSeconds, options)) {
        return AnalysisJobPublishOutcome.SKIPPED;
      }
      if (
        job.publishAttempts >= settings.maxAttempts &&
        !this.requiresPublishRecovery(job)
      ) {
        return AnalysisJobPublishOutcome.SKIPPED;
      }
      this.config.getSqsSettings();

      const deliveryUncertain =
        job.messagePublishedAt !== null ||
        (job.lastErrorCode !== null &&
          INTERNAL_UNCERTAIN_PUBLISH_CODES.has(job.lastErrorCode));
      const claimedNextPublishAt = new Date(
        now.getTime() + settings.republishAfterSeconds * 1000,
      );
      const claimed = await this.repository.claimAttempt({
        job,
        claimedNextPublishAt,
        deliveryUncertain,
      });
      if (!claimed) {
        return AnalysisJobPublishOutcome.SKIPPED;
      }

      const attempt = job.publishAttempts + 1;
      try {
        await this.queue.publish({
          jobId: job.id,
          userId: job.userId,
          repositoryId: job.repositoryId,
          traceId,
        });
      } catch (error) {
        return await this.handlePublishFailure({
          job,
          attempt,
          claimedNextPublishAt,
          deliveryUncertain:
            deliveryUncertain ||
            !(error instanceof AnalysisJobQueueRejectedError),
          now,
          maxAttempts: settings.maxAttempts,
          republishAfterSeconds: settings.republishAfterSeconds,
          random: options.random ?? Math.random(),
          traceId,
          error,
        });
      }

      const recorded = await this.repository.markPublished(
        { job, attempt, claimedNextPublishAt },
        now,
      );
      if (!recorded) {
        this.logger.warn(
          `Analysis job publish acknowledgement was not recorded jobId=${job.id} traceId=${traceId}`,
        );
        return AnalysisJobPublishOutcome.DEFERRED;
      }
      this.logger.log(
        `Analysis job published jobId=${job.id} traceId=${traceId} attempt=${attempt}`,
      );
      return AnalysisJobPublishOutcome.PUBLISHED;
    } catch (error) {
      const reason =
        error instanceof AnalysisJobQueueConfigurationError
          ? error.message
          : 'Publish state could not be updated.';
      this.logger.error(
        `Analysis job publish deferred jobId=${job.id} traceId=${traceId} reason=${reason}`,
      );
      return AnalysisJobPublishOutcome.DEFERRED;
    }
  }

  private async handlePublishFailure(input: {
    job: AnalysisJobPublishRecord;
    attempt: number;
    claimedNextPublishAt: Date;
    deliveryUncertain: boolean;
    now: Date;
    maxAttempts: number;
    republishAfterSeconds: number;
    random: number;
    traceId: string;
    error: unknown;
  }): Promise<AnalysisJobPublishOutcome> {
    const reachedLimit = input.attempt >= input.maxAttempts;
    const terminate =
      reachedLimit &&
      !input.deliveryUncertain &&
      input.job.messagePublishedAt === null &&
      input.job.reservedTokens === null;
    const nextPublishAt = this.nextBackoffAt(
      input.now,
      input.attempt,
      input.republishAfterSeconds,
      input.random,
    );
    const recorded = await this.repository.recordFailure({
      job: input.job,
      attempt: input.attempt,
      claimedNextPublishAt: input.claimedNextPublishAt,
      nextPublishAt,
      deliveryUncertain: input.deliveryUncertain,
      terminate,
      completedAt: input.now,
    });
    if (!recorded) {
      this.logger.warn(
        `Analysis job publish failure state was stale jobId=${input.job.id} traceId=${input.traceId}`,
      );
      return AnalysisJobPublishOutcome.DEFERRED;
    }

    if (reachedLimit && input.job.reservedTokens !== null) {
      this.logger.error(
        `Analysis job reached the publish limit with reserved tokens jobId=${input.job.id} traceId=${input.traceId}`,
      );
    } else {
      this.logger.warn(
        `Analysis job publish attempt failed jobId=${input.job.id} traceId=${input.traceId} attempt=${input.attempt} errorType=${this.errorType(input.error)}`,
      );
    }
    return terminate
      ? AnalysisJobPublishOutcome.FAILED
      : AnalysisJobPublishOutcome.DEFERRED;
  }

  private isDue(
    job: AnalysisJobPublishRecord,
    now: Date,
    republishAfterSeconds: number,
    options: PublishAnalysisJobOptions,
  ): boolean {
    if (
      job.status !== AnalysisJobStatus.QUEUED ||
      job.idempotencyKey.startsWith('sync:') ||
      (job.nextPublishAt !== null && job.nextPublishAt > now)
    ) {
      return false;
    }
    if (job.messagePublishedAt === null) {
      return true;
    }
    return (
      options.allowRepublish &&
      job.messagePublishedAt.getTime() <=
        now.getTime() - republishAfterSeconds * 1000
    );
  }

  private requiresPublishRecovery(job: AnalysisJobPublishRecord): boolean {
    return (
      job.reservedTokens !== null ||
      (job.lastErrorCode !== null &&
        INTERNAL_UNCERTAIN_PUBLISH_CODES.has(job.lastErrorCode))
    );
  }

  private nextBackoffAt(
    now: Date,
    attempt: number,
    baseSeconds: number,
    random: number,
  ): Date {
    const exponentialSeconds = Math.min(
      baseSeconds * 2 ** Math.max(0, attempt - 1),
      MAX_BACKOFF_SECONDS,
    );
    const boundedRandom = Math.min(1, Math.max(0, random));
    const jitterSeconds = exponentialSeconds * JITTER_RATIO * boundedRandom;
    return new Date(
      now.getTime() + (exponentialSeconds + jitterSeconds) * 1000,
    );
  }

  private errorType(error: unknown): string {
    return error instanceof Error && error.name.length > 0
      ? error.name
      : 'UnknownError';
  }
}
