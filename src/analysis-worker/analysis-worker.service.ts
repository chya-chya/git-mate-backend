import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalysisJobStage, AnalysisJobStatus } from '@prisma/client';
import type { SQSBatchResponse, SQSRecord } from 'aws-lambda';
import {
  AnalysisJobExecutionOutcome,
  AnalysisJobRunnerService,
  PostBillingAnalysisPersistenceError,
} from '../analysis/analysis.service';
import { RepositoryCollectionService } from '../collection/repository-collection.service';
import {
  AnalysisWorkerErrorClassification,
  AnalysisWorkerErrorClassifier,
} from './analysis-worker-error-classifier';
import { parseAnalysisWorkerMessage } from './analysis-worker-message.schema';
import {
  AnalysisWorkerJob,
  AnalysisWorkerRepository,
  BilledAnalysisJobRequiresReconciliationError,
} from './analysis-worker.repository';

const DEFAULT_LEASE_SECONDS = 15 * 60;
const MAX_LEASE_SECONDS = 60 * 60;
const DEFAULT_RETRY_BASE_SECONDS = 30;
const MAX_RETRY_BASE_SECONDS = 15 * 60;
const MAX_BACKOFF_SECONDS = 60 * 60;
const JITTER_RATIO = 0.2;
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

enum AnalysisWorkerRecordOutcome {
  ACK = 'ACK',
  RETRY = 'RETRY',
}

@Injectable()
export class AnalysisWorkerService {
  private readonly logger = new Logger(AnalysisWorkerService.name);

  constructor(
    private readonly repository: AnalysisWorkerRepository,
    private readonly repositoryCollection: RepositoryCollectionService,
    private readonly analysisJobRunner: AnalysisJobRunnerService,
    private readonly errorClassifier: AnalysisWorkerErrorClassifier,
    private readonly configService: ConfigService,
  ) {}

  async processBatch(
    records: readonly SQSRecord[],
    awsRequestId: string,
  ): Promise<SQSBatchResponse> {
    const failures = new Set<string>();

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      let outcome: AnalysisWorkerRecordOutcome;
      try {
        outcome = await this.processRecord(record, awsRequestId);
      } catch (error) {
        const classification = this.errorClassifier.classify(error);
        this.logger.error({
          event: 'analysis_worker_record_unhandled_failure',
          messageId: record.messageId,
          traceId: this.traceId(record, awsRequestId),
          errorCode: classification.code,
          errorType: this.errorType(error),
        });
        outcome = AnalysisWorkerRecordOutcome.RETRY;
      }

      if (outcome === AnalysisWorkerRecordOutcome.RETRY) {
        for (const unprocessed of records.slice(index)) {
          failures.add(unprocessed.messageId);
        }
        break;
      }
    }

    return {
      batchItemFailures: [...failures].map((itemIdentifier) => ({
        itemIdentifier,
      })),
    };
  }

  private async processRecord(
    record: SQSRecord,
    awsRequestId: string,
  ): Promise<AnalysisWorkerRecordOutcome> {
    const traceId = this.traceId(record, awsRequestId);
    const parsed = parseAnalysisWorkerMessage(record.body);
    if (parsed.kind === 'INVALID') {
      if (parsed.jobId === null) {
        this.logger.warn({
          event: 'analysis_worker_message_rejected',
          messageId: record.messageId,
          traceId,
          hasJobId: false,
        });
        return AnalysisWorkerRecordOutcome.ACK;
      }
      await this.repository.failQueuedInvalidMessage(parsed.jobId, new Date());
      this.logger.warn({
        event: 'analysis_worker_message_rejected',
        messageId: record.messageId,
        jobId: parsed.jobId,
        traceId,
        hasJobId: true,
      });
      return AnalysisWorkerRecordOutcome.ACK;
    }

    const now = new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = this.leaseExpiresAt(now);
    const claim = await this.repository.claim(
      parsed.message.jobId,
      leaseToken,
      now,
      leaseExpiresAt,
    );

    if (claim.kind === 'NOT_FOUND' || claim.kind === 'TERMINAL') {
      return AnalysisWorkerRecordOutcome.ACK;
    }
    if (claim.kind === 'ACTIVE_LEASE' || claim.kind === 'NOT_DUE') {
      return AnalysisWorkerRecordOutcome.RETRY;
    }
    if (claim.kind === 'MAX_ATTEMPTS') {
      return this.finalizeClaimLimit(claim.job, traceId);
    }

    return this.executeClaimedJob(
      claim.job,
      claim.leaseToken,
      this.receiveCount(record),
      traceId,
    );
  }

  private async executeClaimedJob(
    job: AnalysisWorkerJob,
    leaseToken: string,
    receiveCount: number,
    traceId: string,
  ): Promise<AnalysisWorkerRecordOutcome> {
    try {
      const collectedData = await this.repositoryCollection.collect({
        userId: job.userId,
        githubRepoId: job.repository.githubRepoId,
        fullName: job.repository.fullName,
        targetUser: job.repository.owner.username,
        sourceCursor: job.sourceCursor ?? undefined,
      });
      await this.updateProgress(
        job.id,
        leaseToken,
        AnalysisJobStage.RESERVING_TOKENS,
        35,
      );

      const result = await this.analysisJobRunner.runAnalysisJob(
        collectedData,
        { jobId: job.id, leaseToken },
        (transaction) =>
          this.repository.advanceRepositoryCheckpoint(job, transaction),
        {
          deferUnbilledProviderErrors: true,
          onTokensReserved: () =>
            this.updateProgress(
              job.id,
              leaseToken,
              AnalysisJobStage.ANALYZING,
              55,
            ),
          onSaving: () =>
            this.updateProgress(
              job.id,
              leaseToken,
              AnalysisJobStage.SAVING,
              90,
            ),
        },
      );

      this.logger.log({
        event: 'analysis_worker_job_finished',
        jobId: job.id,
        traceId,
        attempt: job.attemptCount,
        outcome: result.outcome,
      });
      return this.isTerminalOutcome(result.outcome)
        ? AnalysisWorkerRecordOutcome.ACK
        : AnalysisWorkerRecordOutcome.RETRY;
    } catch (error) {
      return this.handleClaimedFailure(
        job,
        leaseToken,
        receiveCount,
        traceId,
        error,
      );
    }
  }

  private async handleClaimedFailure(
    job: AnalysisWorkerJob,
    leaseToken: string,
    receiveCount: number,
    traceId: string,
    error: unknown,
  ): Promise<AnalysisWorkerRecordOutcome> {
    const classification = this.errorClassifier.classify(error);
    this.logger.warn({
      event: 'analysis_worker_job_failed',
      jobId: job.id,
      traceId,
      attempt: job.attemptCount,
      lease: this.shortLease(leaseToken),
      errorCode: classification.code,
      errorType: this.errorType(error),
      retryable: classification.retryable,
    });

    if (
      error instanceof PostBillingAnalysisPersistenceError ||
      error instanceof BilledAnalysisJobRequiresReconciliationError
    ) {
      this.logger.error({
        event: 'analysis_worker_billed_persistence_unresolved',
        jobId: job.id,
        traceId,
        errorCode: classification.code,
      });
      return AnalysisWorkerRecordOutcome.RETRY;
    }

    if (classification.retryable) {
      if (
        job.attemptCount >= job.maxAttempts ||
        receiveCount >= job.maxAttempts
      ) {
        return this.finalizeRunningAtLimit(job.id, leaseToken, traceId);
      }
      try {
        await this.repository.releaseForRetry({
          jobId: job.id,
          leaseToken,
          nextPublishAt: this.nextBackoffAt(new Date(), job.attemptCount),
          errorCode: classification.code,
          errorMessage: classification.message,
        });
      } catch (releaseError) {
        this.logPersistenceFailure(
          'analysis_worker_retry_state_persistence_failed',
          job.id,
          traceId,
          releaseError,
        );
      }
      return AnalysisWorkerRecordOutcome.RETRY;
    }

    try {
      const finalized = await this.repository.finalizeRunningFailure({
        jobId: job.id,
        leaseToken,
        completedAt: new Date(),
        errorCode: classification.code,
        errorMessage: classification.message,
        errorRetryable: false,
      });
      return finalized
        ? AnalysisWorkerRecordOutcome.ACK
        : AnalysisWorkerRecordOutcome.RETRY;
    } catch (finalizeError) {
      this.logPersistenceFailure(
        'analysis_worker_terminal_state_persistence_failed',
        job.id,
        traceId,
        finalizeError,
      );
      return AnalysisWorkerRecordOutcome.RETRY;
    }
  }

  private async finalizeClaimLimit(
    job: AnalysisWorkerJob,
    traceId: string,
  ): Promise<AnalysisWorkerRecordOutcome> {
    try {
      const finalized =
        job.status === AnalysisJobStatus.QUEUED
          ? await this.repository.finalizeQueuedAtLimit(job.id, new Date())
          : job.leaseToken === null
            ? false
            : await this.repository.finalizeRunningFailure({
                jobId: job.id,
                leaseToken: job.leaseToken,
                completedAt: new Date(),
                errorCode: 'MAX_ATTEMPTS_EXCEEDED',
                errorMessage: 'The maximum number of attempts was exceeded.',
                errorRetryable: true,
              });
      if (!finalized) {
        return AnalysisWorkerRecordOutcome.RETRY;
      }
      this.logger.error({
        event: 'analysis_worker_max_attempts_exceeded',
        jobId: job.id,
        traceId,
        attempt: job.attemptCount,
      });
      return AnalysisWorkerRecordOutcome.RETRY;
    } catch (error) {
      this.logPersistenceFailure(
        'analysis_worker_max_attempt_persistence_failed',
        job.id,
        traceId,
        error,
      );
      return AnalysisWorkerRecordOutcome.RETRY;
    }
  }

  private async finalizeRunningAtLimit(
    jobId: string,
    leaseToken: string,
    traceId: string,
  ): Promise<AnalysisWorkerRecordOutcome> {
    try {
      await this.repository.finalizeRunningFailure({
        jobId,
        leaseToken,
        completedAt: new Date(),
        errorCode: 'MAX_ATTEMPTS_EXCEEDED',
        errorMessage: 'The maximum number of attempts was exceeded.',
        errorRetryable: true,
      });
    } catch (error) {
      this.logPersistenceFailure(
        'analysis_worker_max_attempt_persistence_failed',
        jobId,
        traceId,
        error,
      );
    }
    return AnalysisWorkerRecordOutcome.RETRY;
  }

  private updateProgress(
    jobId: string,
    leaseToken: string,
    stage: AnalysisJobStage,
    progress: number,
  ): Promise<void> {
    const heartbeatAt = new Date();
    return this.repository.updateProgress({
      jobId,
      leaseToken,
      stage,
      progress,
      heartbeatAt,
      leaseExpiresAt: this.leaseExpiresAt(heartbeatAt),
    });
  }

  private isTerminalOutcome(outcome: AnalysisJobExecutionOutcome): boolean {
    return Object.values(AnalysisJobExecutionOutcome).includes(outcome);
  }

  private receiveCount(record: SQSRecord): number {
    const parsed = Number(record.attributes.ApproximateReceiveCount);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  }

  private traceId(record: SQSRecord, awsRequestId: string): string {
    const attribute = record.messageAttributes.traceId;
    const value = attribute?.stringValue;
    return attribute?.dataType === 'String' &&
      typeof value === 'string' &&
      TRACE_ID_PATTERN.test(value)
      ? value
      : awsRequestId;
  }

  private leaseExpiresAt(now: Date): Date {
    return new Date(now.getTime() + this.leaseSeconds() * 1000);
  }

  private leaseSeconds(): number {
    return this.positiveIntegerConfig(
      'ANALYSIS_WORKER_LEASE_SECONDS',
      DEFAULT_LEASE_SECONDS,
      MAX_LEASE_SECONDS,
    );
  }

  private retryBaseSeconds(): number {
    return this.positiveIntegerConfig(
      'ANALYSIS_WORKER_RETRY_BASE_SECONDS',
      DEFAULT_RETRY_BASE_SECONDS,
      MAX_RETRY_BASE_SECONDS,
    );
  }

  private positiveIntegerConfig(
    name: string,
    fallback: number,
    maximum: number,
  ): number {
    const raw = this.configService.get<string>(name)?.trim();
    if (!raw) {
      return fallback;
    }
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 && value <= maximum
      ? value
      : fallback;
  }

  private nextBackoffAt(now: Date, attempt: number): Date {
    const exponentialSeconds = Math.min(
      this.retryBaseSeconds() * 2 ** Math.max(0, attempt - 1),
      MAX_BACKOFF_SECONDS,
    );
    const jitterSeconds = exponentialSeconds * JITTER_RATIO * Math.random();
    return new Date(
      now.getTime() + (exponentialSeconds + jitterSeconds) * 1000,
    );
  }

  private shortLease(leaseToken: string): string {
    return leaseToken.slice(0, 8);
  }

  private errorType(error: unknown): string {
    return error instanceof Error && error.name.length > 0
      ? error.name
      : 'UnknownError';
  }

  private logPersistenceFailure(
    event: string,
    jobId: string,
    traceId: string,
    error: unknown,
  ): void {
    const classification: AnalysisWorkerErrorClassification =
      this.errorClassifier.classify(error);
    this.logger.error({
      event,
      jobId,
      traceId,
      errorCode: classification.code,
      errorType: this.errorType(error),
    });
  }
}
