import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AnalysisJob,
  AnalysisJobStage,
  AnalysisJobStatus,
} from '@prisma/client';
import {
  AnalysisJobDatabase,
  AnalysisJobRepository,
  RunningAnalysisJobContext,
  TransitionAnalysisJobRecordInput,
} from './analysis-job.repository';

const ALLOWED_TRANSITIONS: Record<
  AnalysisJobStatus,
  readonly AnalysisJobStatus[]
> = {
  QUEUED: [AnalysisJobStatus.RUNNING, AnalysisJobStatus.FAILED],
  RUNNING: [
    AnalysisJobStatus.QUEUED,
    AnalysisJobStatus.SUCCEEDED,
    AnalysisJobStatus.FAILED,
  ],
  SUCCEEDED: [],
  FAILED: [],
};

const VERSION_PATTERN = /^[A-Za-z0-9._:/-]{1,64}$/;
const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const MAX_PROVIDER_REQUEST_IDS = 10;

export enum AnalysisJobFailureCode {
  ANALYSIS_FAILED = 'ANALYSIS_FAILED',
  INSUFFICIENT_TOKENS = 'INSUFFICIENT_TOKENS',
  MAX_ATTEMPTS_EXCEEDED = 'MAX_ATTEMPTS_EXCEEDED',
  NO_ANALYZABLE_DATA = 'NO_ANALYZABLE_DATA',
  PUBLISH_FAILED = 'PUBLISH_FAILED',
  REPOSITORY_UNAVAILABLE = 'REPOSITORY_UNAVAILABLE',
  TOKEN_BUDGET_EXCEEDED = 'TOKEN_BUDGET_EXCEEDED',
}

const SAFE_ERROR_MESSAGES: Record<AnalysisJobFailureCode, string> = {
  [AnalysisJobFailureCode.ANALYSIS_FAILED]: 'Analysis failed.',
  [AnalysisJobFailureCode.INSUFFICIENT_TOKENS]:
    'The token balance is insufficient.',
  [AnalysisJobFailureCode.MAX_ATTEMPTS_EXCEEDED]:
    'The maximum number of attempts was exceeded.',
  [AnalysisJobFailureCode.NO_ANALYZABLE_DATA]:
    'No analyzable repository activity was found.',
  [AnalysisJobFailureCode.PUBLISH_FAILED]:
    'The analysis job could not be published.',
  [AnalysisJobFailureCode.REPOSITORY_UNAVAILABLE]:
    'The repository is unavailable.',
  [AnalysisJobFailureCode.TOKEN_BUDGET_EXCEEDED]:
    'The analysis exceeded its token budget.',
};

export interface CreateAnalysisJobInput {
  userId: number;
  repositoryId: number;
  idempotencyKey: string;
  modelVersion: string;
  promptVersion: string;
  sourceCursor?: Date | null;
}

interface TokenSettlementInput {
  completedAt: Date;
  tokensSettledAt: Date;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providerRequestIds: string[];
}

interface FailureInput extends TokenSettlementInput {
  errorCode: AnalysisJobFailureCode;
  errorRetryable: boolean;
}

export type TransitionAnalysisJobInput =
  | {
      jobId: string;
      fromStatus: typeof AnalysisJobStatus.QUEUED;
      toStatus: typeof AnalysisJobStatus.RUNNING;
      data: {
        leaseToken: string;
        leaseExpiresAt: Date;
        startedAt: Date;
      };
    }
  | {
      jobId: string;
      fromStatus: typeof AnalysisJobStatus.RUNNING;
      toStatus: typeof AnalysisJobStatus.QUEUED;
      expectedLeaseToken: string;
      data: {
        nextPublishAt: Date;
        errorCode: AnalysisJobFailureCode;
      };
    }
  | {
      jobId: string;
      fromStatus: typeof AnalysisJobStatus.RUNNING;
      toStatus: typeof AnalysisJobStatus.SUCCEEDED;
      expectedLeaseToken: string;
      expectedUserId: number;
      expectedRepositoryId: number;
      expectedReservedTokens: number;
      data: TokenSettlementInput & { reportId: number };
    }
  | {
      jobId: string;
      fromStatus: typeof AnalysisJobStatus.QUEUED;
      toStatus: typeof AnalysisJobStatus.FAILED;
      data: FailureInput;
    }
  | {
      jobId: string;
      fromStatus: typeof AnalysisJobStatus.RUNNING;
      toStatus: typeof AnalysisJobStatus.FAILED;
      expectedLeaseToken: string;
      expectedUserId: number;
      expectedRepositoryId: number;
      expectedReservedTokens: number | null;
      data: FailureInput;
    };

export interface ReserveAnalysisJobTokensInput {
  jobId: string;
  expectedLeaseToken: string;
  expectedUserId: number;
  expectedRepositoryId: number;
  estimatedTokens: number;
  reservedTokens: number;
}

export class InvalidAnalysisJobInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = InvalidAnalysisJobInputError.name;
  }
}

export class InvalidAnalysisJobTransitionError extends Error {
  constructor(fromStatus: AnalysisJobStatus, toStatus: AnalysisJobStatus) {
    super(`Analysis job cannot transition from ${fromStatus} to ${toStatus}`);
    this.name = InvalidAnalysisJobTransitionError.name;
  }
}

export class StaleAnalysisJobTransitionError extends Error {
  constructor(jobId: string, fromStatus: AnalysisJobStatus) {
    super(
      `Analysis job ${jobId} is no longer in the expected ${fromStatus} state`,
    );
    this.name = StaleAnalysisJobTransitionError.name;
  }
}

export function canTransitionAnalysisJob(
  fromStatus: AnalysisJobStatus,
  toStatus: AnalysisJobStatus,
): boolean {
  return ALLOWED_TRANSITIONS[fromStatus].includes(toStatus);
}

@Injectable()
export class AnalysisJobService {
  constructor(private readonly repository: AnalysisJobRepository) {}

  create(input: CreateAnalysisJobInput): Promise<AnalysisJob> {
    this.validateCreateInput(input);

    return this.repository.create({
      ...input,
      requestHash: this.createRequestHash(input),
      status: AnalysisJobStatus.QUEUED,
      stage: AnalysisJobStage.WAITING,
      progress: 0,
    });
  }

  findById(jobId: string): Promise<AnalysisJob | null> {
    return this.repository.findById(jobId);
  }

  async getRunningJobContext(
    jobId: string,
    expectedLeaseToken: string,
  ): Promise<RunningAnalysisJobContext> {
    this.assertNonEmptyString(jobId, 'jobId');
    this.assertNonEmptyString(expectedLeaseToken, 'expectedLeaseToken');
    const job = await this.repository.findRunningByLease(
      jobId,
      expectedLeaseToken,
    );
    if (!job) {
      throw new StaleAnalysisJobTransitionError(
        jobId,
        AnalysisJobStatus.RUNNING,
      );
    }
    return job;
  }

  async transition(
    input: TransitionAnalysisJobInput,
    database?: AnalysisJobDatabase,
  ): Promise<void> {
    if (!canTransitionAnalysisJob(input.fromStatus, input.toStatus)) {
      throw new InvalidAnalysisJobTransitionError(
        input.fromStatus,
        input.toStatus,
      );
    }

    this.validateTransitionInput(input);
    const record = this.toTransitionRecord(input);
    const transitioned = await this.repository.transitionStatus(
      record,
      database,
    );

    if (!transitioned) {
      throw new StaleAnalysisJobTransitionError(input.jobId, input.fromStatus);
    }
  }

  async reserveTokens(
    input: ReserveAnalysisJobTokensInput,
    database: AnalysisJobDatabase,
  ): Promise<void> {
    this.assertNonEmptyString(input.jobId, 'jobId');
    this.assertNonEmptyString(input.expectedLeaseToken, 'expectedLeaseToken');
    this.assertPositiveInteger(input.expectedUserId, 'expectedUserId');
    this.assertPositiveInteger(
      input.expectedRepositoryId,
      'expectedRepositoryId',
    );
    this.assertTokenCount(input.estimatedTokens, 'estimatedTokens');
    this.assertTokenCount(input.reservedTokens, 'reservedTokens');
    if (input.reservedTokens < input.estimatedTokens) {
      throw new InvalidAnalysisJobInputError(
        'reservedTokens must be greater than or equal to estimatedTokens',
      );
    }

    const reserved = await this.repository.reserveTokens(input, database);
    if (!reserved) {
      throw new StaleAnalysisJobTransitionError(
        input.jobId,
        AnalysisJobStatus.RUNNING,
      );
    }
  }

  private validateCreateInput(input: CreateAnalysisJobInput): void {
    if (!Number.isInteger(input.userId) || input.userId <= 0) {
      throw new InvalidAnalysisJobInputError(
        'userId must be a positive integer',
      );
    }
    if (!Number.isInteger(input.repositoryId) || input.repositoryId <= 0) {
      throw new InvalidAnalysisJobInputError(
        'repositoryId must be a positive integer',
      );
    }
    if (
      input.idempotencyKey.length === 0 ||
      input.idempotencyKey.length > 128 ||
      input.idempotencyKey.startsWith('legacy-report:') ||
      [...input.idempotencyKey].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      throw new InvalidAnalysisJobInputError('idempotencyKey is invalid');
    }
    if (!VERSION_PATTERN.test(input.modelVersion)) {
      throw new InvalidAnalysisJobInputError('modelVersion is invalid');
    }
    if (!VERSION_PATTERN.test(input.promptVersion)) {
      throw new InvalidAnalysisJobInputError('promptVersion is invalid');
    }
    if (input.sourceCursor != null) {
      this.assertValidDate(input.sourceCursor, 'sourceCursor');
    }
  }

  private createRequestHash(input: CreateAnalysisJobInput): string {
    const canonicalRequest = JSON.stringify({
      userId: input.userId,
      repositoryId: input.repositoryId,
      sourceCursor: input.sourceCursor?.toISOString() ?? null,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
    });

    return createHash('sha256').update(canonicalRequest).digest('hex');
  }

  private validateTransitionInput(input: TransitionAnalysisJobInput): void {
    if (input.fromStatus === AnalysisJobStatus.RUNNING) {
      const leaseToken = (input as { expectedLeaseToken?: unknown })
        .expectedLeaseToken;
      this.assertNonEmptyString(leaseToken, 'expectedLeaseToken');
    }

    if (
      input.fromStatus === AnalysisJobStatus.QUEUED &&
      input.toStatus === AnalysisJobStatus.RUNNING
    ) {
      this.assertNonEmptyString(input.data.leaseToken, 'leaseToken');
      this.assertValidDate(input.data.leaseExpiresAt, 'leaseExpiresAt');
      this.assertValidDate(input.data.startedAt, 'startedAt');
      return;
    }

    if (input.toStatus === AnalysisJobStatus.QUEUED) {
      this.assertValidDate(input.data.nextPublishAt, 'nextPublishAt');
      this.assertFailureCode(input.data.errorCode);
      return;
    }

    this.assertTokenSettlement(input.data);
    if (input.toStatus === AnalysisJobStatus.SUCCEEDED) {
      if (!Number.isInteger(input.data.reportId) || input.data.reportId <= 0) {
        throw new InvalidAnalysisJobInputError(
          'reportId must be a positive integer',
        );
      }
      if (
        !Number.isInteger(input.expectedUserId) ||
        input.expectedUserId <= 0
      ) {
        throw new InvalidAnalysisJobInputError(
          'expectedUserId must be a positive integer',
        );
      }
      if (
        !Number.isInteger(input.expectedRepositoryId) ||
        input.expectedRepositoryId <= 0
      ) {
        throw new InvalidAnalysisJobInputError(
          'expectedRepositoryId must be a positive integer',
        );
      }
      this.assertTokenCount(
        input.expectedReservedTokens,
        'expectedReservedTokens',
      );
      return;
    }

    this.assertFailureCode(input.data.errorCode);
    if (typeof input.data.errorRetryable !== 'boolean') {
      throw new InvalidAnalysisJobInputError(
        'errorRetryable must be a boolean',
      );
    }
    if (input.fromStatus === AnalysisJobStatus.RUNNING) {
      this.assertPositiveInteger(input.expectedUserId, 'expectedUserId');
      this.assertPositiveInteger(
        input.expectedRepositoryId,
        'expectedRepositoryId',
      );
      if (input.expectedReservedTokens !== null) {
        this.assertTokenCount(
          input.expectedReservedTokens,
          'expectedReservedTokens',
        );
      }
    }
  }

  private assertTokenSettlement(input: TokenSettlementInput): void {
    this.assertValidDate(input.completedAt, 'completedAt');
    this.assertValidDate(input.tokensSettledAt, 'tokensSettledAt');
    this.assertTokenCount(input.promptTokens, 'promptTokens');
    this.assertTokenCount(input.completionTokens, 'completionTokens');
    this.assertTokenCount(input.totalTokens, 'totalTokens');

    if (input.promptTokens + input.completionTokens !== input.totalTokens) {
      throw new InvalidAnalysisJobInputError(
        'totalTokens must equal promptTokens plus completionTokens',
      );
    }
    if (
      !Array.isArray(input.providerRequestIds) ||
      input.providerRequestIds.length > MAX_PROVIDER_REQUEST_IDS ||
      input.providerRequestIds.some(
        (requestId) => !PROVIDER_REQUEST_ID_PATTERN.test(requestId),
      )
    ) {
      throw new InvalidAnalysisJobInputError('providerRequestIds is invalid');
    }
  }

  private assertTokenCount(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new InvalidAnalysisJobInputError(
        `${field} must be a non-negative safe integer`,
      );
    }
  }

  private assertPositiveInteger(value: number, field: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new InvalidAnalysisJobInputError(
        `${field} must be a positive integer`,
      );
    }
  }

  private assertFailureCode(value: AnalysisJobFailureCode): void {
    if (!Object.values(AnalysisJobFailureCode).includes(value)) {
      throw new InvalidAnalysisJobInputError('errorCode is invalid');
    }
  }

  private assertNonEmptyString(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidAnalysisJobInputError(`${field} is required`);
    }
  }

  private assertValidDate(value: Date, field: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidAnalysisJobInputError(`${field} must be a valid date`);
    }
  }

  private toTransitionRecord(
    input: TransitionAnalysisJobInput,
  ): TransitionAnalysisJobRecordInput {
    if (
      input.fromStatus === AnalysisJobStatus.QUEUED &&
      input.toStatus === AnalysisJobStatus.RUNNING
    ) {
      return {
        jobId: input.jobId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        data: {
          stage: AnalysisJobStage.COLLECTING,
          leaseToken: input.data.leaseToken,
          leaseExpiresAt: input.data.leaseExpiresAt,
          heartbeatAt: input.data.startedAt,
          startedAt: input.data.startedAt,
        },
      };
    }

    if (input.toStatus === AnalysisJobStatus.QUEUED) {
      return {
        jobId: input.jobId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        expectedLeaseToken: input.expectedLeaseToken,
        data: {
          stage: AnalysisJobStage.WAITING,
          nextPublishAt: input.data.nextPublishAt,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          lastErrorCode: input.data.errorCode,
          lastErrorMessage: SAFE_ERROR_MESSAGES[input.data.errorCode],
          errorRetryable: true,
        },
      };
    }

    const terminalData = {
      stage: null,
      progress:
        input.toStatus === AnalysisJobStatus.SUCCEEDED ? 100 : undefined,
      promptTokens: input.data.promptTokens,
      completionTokens: input.data.completionTokens,
      totalTokens: input.data.totalTokens,
      tokensSettledAt: input.data.tokensSettledAt,
      providerRequestIds: [...input.data.providerRequestIds],
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      completedAt: input.data.completedAt,
    };

    if (input.toStatus === AnalysisJobStatus.SUCCEEDED) {
      return {
        jobId: input.jobId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        expectedLeaseToken: input.expectedLeaseToken,
        requiredReportId: input.data.reportId,
        requiredUserId: input.expectedUserId,
        requiredRepositoryId: input.expectedRepositoryId,
        requiredReservedTokens: input.expectedReservedTokens,
        data: terminalData,
      };
    }

    const failureData = {
      ...terminalData,
      lastErrorCode: input.data.errorCode,
      lastErrorMessage: SAFE_ERROR_MESSAGES[input.data.errorCode],
      errorRetryable: input.data.errorRetryable,
    };

    if (input.fromStatus === AnalysisJobStatus.RUNNING) {
      return {
        jobId: input.jobId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        expectedLeaseToken: input.expectedLeaseToken,
        requiredUserId: input.expectedUserId,
        requiredRepositoryId: input.expectedRepositoryId,
        requiredReservedTokens: input.expectedReservedTokens,
        data: failureData,
      };
    }

    return {
      jobId: input.jobId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      data: failureData,
    };
  }
}
