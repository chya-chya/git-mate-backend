import { Injectable } from '@nestjs/common';
import { AnalysisJobStage, AnalysisJobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const analysisWorkerJobSelect = {
  id: true,
  status: true,
  stage: true,
  progress: true,
  userId: true,
  repositoryId: true,
  sourceCursor: true,
  reservedTokens: true,
  promptTokens: true,
  completionTokens: true,
  totalTokens: true,
  providerRequestIds: true,
  attemptCount: true,
  maxAttempts: true,
  nextPublishAt: true,
  leaseToken: true,
  leaseExpiresAt: true,
  createdAt: true,
  completedAt: true,
  tokensSettledAt: true,
  repository: {
    select: {
      githubRepoId: true,
      fullName: true,
      owner: { select: { username: true } },
    },
  },
} satisfies Prisma.AnalysisJobSelect;

export type AnalysisWorkerJob = Prisma.AnalysisJobGetPayload<{
  select: typeof analysisWorkerJobSelect;
}>;

export type AnalysisWorkerClaimResult =
  | { kind: 'CLAIMED'; job: AnalysisWorkerJob; leaseToken: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'TERMINAL' }
  | { kind: 'ACTIVE_LEASE' }
  | { kind: 'NOT_DUE' }
  | { kind: 'MAX_ATTEMPTS'; job: AnalysisWorkerJob };

export type AnalysisWorkerCompletionDatabase = Pick<
  Prisma.TransactionClient,
  'repository'
>;

interface FailureSettlementRow {
  id: string;
  status: AnalysisJobStatus;
  userId: number;
  reservedTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  tokensSettledAt: Date | null;
  providerRequestIds: string[];
  leaseToken: string | null;
}

export class StaleAnalysisWorkerLeaseError extends Error {
  constructor(jobId: string) {
    super(`Analysis job ${jobId} is not owned by this worker.`);
    this.name = StaleAnalysisWorkerLeaseError.name;
  }
}

export class BilledAnalysisJobRequiresReconciliationError extends Error {
  constructor(jobId: string) {
    super(`Analysis job ${jobId} contains provider billing evidence.`);
    this.name = BilledAnalysisJobRequiresReconciliationError.name;
  }
}

@Injectable()
export class AnalysisWorkerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async claim(
    jobId: string,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<AnalysisWorkerClaimResult> {
    const current = await this.findJob(jobId);
    if (!current) {
      return { kind: 'NOT_FOUND' };
    }
    if (
      current.status === AnalysisJobStatus.SUCCEEDED ||
      current.status === AnalysisJobStatus.FAILED
    ) {
      return { kind: 'TERMINAL' };
    }

    if (current.status === AnalysisJobStatus.QUEUED) {
      if (current.attemptCount >= current.maxAttempts) {
        return { kind: 'MAX_ATTEMPTS', job: current };
      }
      if (current.completedAt !== null || current.tokensSettledAt !== null) {
        return { kind: 'TERMINAL' };
      }
      if (current.nextPublishAt !== null && current.nextPublishAt > now) {
        return { kind: 'NOT_DUE' };
      }
      const claimed = await this.claimQueued(
        jobId,
        leaseToken,
        now,
        leaseExpiresAt,
      );
      return claimed
        ? {
            kind: 'CLAIMED',
            job: await this.requireClaimedJob(jobId, leaseToken),
            leaseToken,
          }
        : this.resolveClaimRace(jobId, now);
    }

    if (
      current.leaseExpiresAt !== null &&
      current.leaseExpiresAt.getTime() > now.getTime()
    ) {
      return { kind: 'ACTIVE_LEASE' };
    }
    if (current.attemptCount >= current.maxAttempts) {
      return { kind: 'MAX_ATTEMPTS', job: current };
    }
    if (current.leaseToken === null || current.leaseExpiresAt === null) {
      return { kind: 'ACTIVE_LEASE' };
    }

    const takenOver = await this.takeOverExpiredLease(
      current,
      leaseToken,
      now,
      leaseExpiresAt,
    );
    return takenOver
      ? {
          kind: 'CLAIMED',
          job: await this.requireClaimedJob(jobId, leaseToken),
          leaseToken,
        }
      : this.resolveClaimRace(jobId, now);
  }

  async updateProgress(input: {
    jobId: string;
    leaseToken: string;
    stage: AnalysisJobStage;
    progress: number;
    heartbeatAt: Date;
    leaseExpiresAt: Date;
  }): Promise<void> {
    const result = await this.prisma.analysisJob.updateMany({
      where: {
        id: input.jobId,
        status: AnalysisJobStatus.RUNNING,
        leaseToken: input.leaseToken,
        tokensSettledAt: null,
      },
      data: {
        stage: input.stage,
        progress: input.progress,
        heartbeatAt: input.heartbeatAt,
        leaseExpiresAt: input.leaseExpiresAt,
      },
    });
    if (result.count !== 1) {
      throw new StaleAnalysisWorkerLeaseError(input.jobId);
    }
  }

  async releaseForRetry(input: {
    jobId: string;
    leaseToken: string;
    nextPublishAt: Date;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    const result = await this.prisma.analysisJob.updateMany({
      where: {
        id: input.jobId,
        status: AnalysisJobStatus.RUNNING,
        leaseToken: input.leaseToken,
        tokensSettledAt: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        providerRequestIds: { isEmpty: true },
      },
      data: {
        status: AnalysisJobStatus.QUEUED,
        stage: AnalysisJobStage.WAITING,
        nextPublishAt: input.nextPublishAt,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        lastErrorCode: input.errorCode,
        lastErrorMessage: input.errorMessage,
        errorRetryable: true,
      },
    });
    if (result.count !== 1) {
      const current = await this.findJob(input.jobId);
      if (current?.status === AnalysisJobStatus.FAILED) {
        return;
      }
      if (
        current !== null &&
        (current.providerRequestIds.length > 0 ||
          current.promptTokens !== null ||
          current.completionTokens !== null ||
          current.totalTokens !== null)
      ) {
        throw new BilledAnalysisJobRequiresReconciliationError(input.jobId);
      }
      throw new StaleAnalysisWorkerLeaseError(input.jobId);
    }
  }

  failQueuedInvalidMessage(jobId: string, completedAt: Date): Promise<boolean> {
    return this.settleFailure({
      jobId,
      expectedStatus: AnalysisJobStatus.QUEUED,
      expectedLeaseToken: null,
      completedAt,
      errorCode: 'INVALID_MESSAGE',
      errorMessage: 'The analysis job message is invalid.',
      errorRetryable: false,
    });
  }

  finalizeRunningFailure(input: {
    jobId: string;
    leaseToken: string;
    completedAt: Date;
    errorCode: string;
    errorMessage: string;
    errorRetryable: boolean;
  }): Promise<boolean> {
    return this.settleFailure({
      jobId: input.jobId,
      expectedStatus: AnalysisJobStatus.RUNNING,
      expectedLeaseToken: input.leaseToken,
      completedAt: input.completedAt,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      errorRetryable: input.errorRetryable,
    });
  }

  finalizeQueuedAtLimit(jobId: string, completedAt: Date): Promise<boolean> {
    return this.settleFailure({
      jobId,
      expectedStatus: AnalysisJobStatus.QUEUED,
      expectedLeaseToken: null,
      completedAt,
      errorCode: 'MAX_ATTEMPTS_EXCEEDED',
      errorMessage: 'The maximum number of attempts was exceeded.',
      errorRetryable: true,
    });
  }

  advanceRepositoryCheckpoint(
    job: Pick<AnalysisWorkerJob, 'repositoryId' | 'userId' | 'createdAt'>,
    database: AnalysisWorkerCompletionDatabase,
  ) {
    return database.repository.updateMany({
      where: {
        id: job.repositoryId,
        ownerId: job.userId,
        OR: [{ lastSyncTime: null }, { lastSyncTime: { lt: job.createdAt } }],
      },
      data: { lastSyncTime: job.createdAt },
    });
  }

  private findJob(jobId: string): Promise<AnalysisWorkerJob | null> {
    return this.prisma.analysisJob.findUnique({
      where: { id: jobId },
      select: analysisWorkerJobSelect,
    });
  }

  private async requireClaimedJob(
    jobId: string,
    leaseToken: string,
  ): Promise<AnalysisWorkerJob> {
    const job = await this.prisma.analysisJob.findFirst({
      where: {
        id: jobId,
        status: AnalysisJobStatus.RUNNING,
        leaseToken,
      },
      select: analysisWorkerJobSelect,
    });
    if (!job) {
      throw new StaleAnalysisWorkerLeaseError(jobId);
    }
    return job;
  }

  private async claimQueued(
    jobId: string,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "analysis_jobs"
      SET
        "status" = 'RUNNING'::"AnalysisJobStatus",
        "stage" = 'COLLECTING'::"AnalysisJobStage",
        "progress" = 10,
        "attemptCount" = "attemptCount" + 1,
        "leaseToken" = ${leaseToken},
        "leaseExpiresAt" = ${leaseExpiresAt},
        "heartbeatAt" = ${now},
        "startedAt" = COALESCE("startedAt", ${now}),
        "nextPublishAt" = NULL,
        "lastErrorCode" = NULL,
        "lastErrorMessage" = NULL,
        "errorRetryable" = NULL,
        "updatedAt" = ${now}
      WHERE
        "id" = ${jobId}
        AND "status" = 'QUEUED'::"AnalysisJobStatus"
        AND "attemptCount" < "maxAttempts"
        AND ("nextPublishAt" IS NULL OR "nextPublishAt" <= ${now})
        AND "completedAt" IS NULL
        AND "tokensSettledAt" IS NULL
      RETURNING "id"
    `;
    return rows.length === 1;
  }

  private async takeOverExpiredLease(
    current: AnalysisWorkerJob,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "analysis_jobs"
      SET
        "stage" = 'COLLECTING'::"AnalysisJobStage",
        "progress" = 10,
        "attemptCount" = "attemptCount" + 1,
        "leaseToken" = ${leaseToken},
        "leaseExpiresAt" = ${leaseExpiresAt},
        "heartbeatAt" = ${now},
        "startedAt" = COALESCE("startedAt", ${now}),
        "lastErrorCode" = NULL,
        "lastErrorMessage" = NULL,
        "errorRetryable" = NULL,
        "updatedAt" = ${now}
      WHERE
        "id" = ${current.id}
        AND "status" = 'RUNNING'::"AnalysisJobStatus"
        AND "leaseToken" = ${current.leaseToken}
        AND "leaseExpiresAt" = ${current.leaseExpiresAt}
        AND "leaseExpiresAt" <= ${now}
        AND "attemptCount" = ${current.attemptCount}
        AND "attemptCount" < "maxAttempts"
        AND "completedAt" IS NULL
        AND "tokensSettledAt" IS NULL
      RETURNING "id"
    `;
    return rows.length === 1;
  }

  private async resolveClaimRace(
    jobId: string,
    now: Date,
  ): Promise<AnalysisWorkerClaimResult> {
    const current = await this.findJob(jobId);
    if (!current) {
      return { kind: 'NOT_FOUND' };
    }
    if (
      current.status === AnalysisJobStatus.SUCCEEDED ||
      current.status === AnalysisJobStatus.FAILED
    ) {
      return { kind: 'TERMINAL' };
    }
    if (current.nextPublishAt !== null && current.nextPublishAt > now) {
      return { kind: 'NOT_DUE' };
    }
    if (
      current.status === AnalysisJobStatus.RUNNING &&
      current.leaseExpiresAt !== null &&
      current.leaseExpiresAt > now
    ) {
      return { kind: 'ACTIVE_LEASE' };
    }
    if (current.attemptCount >= current.maxAttempts) {
      return { kind: 'MAX_ATTEMPTS', job: current };
    }
    return { kind: 'ACTIVE_LEASE' };
  }

  private settleFailure(input: {
    jobId: string;
    expectedStatus: AnalysisJobStatus;
    expectedLeaseToken: string | null;
    completedAt: Date;
    errorCode: string;
    errorMessage: string;
    errorRetryable: boolean;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<FailureSettlementRow[]>`
        SELECT
          "id",
          "status",
          "userId",
          "reservedTokens",
          "promptTokens",
          "completionTokens",
          "totalTokens",
          "tokensSettledAt",
          "providerRequestIds",
          "leaseToken"
        FROM "analysis_jobs"
        WHERE "id" = ${input.jobId}
        FOR UPDATE
      `;
      const job = rows.at(0);
      if (
        !job ||
        job.status !== input.expectedStatus ||
        job.tokensSettledAt !== null ||
        (input.expectedStatus === AnalysisJobStatus.RUNNING &&
          job.leaseToken !== input.expectedLeaseToken)
      ) {
        return false;
      }
      if (
        job.providerRequestIds.length > 0 ||
        job.promptTokens !== null ||
        job.completionTokens !== null ||
        job.totalTokens !== null
      ) {
        throw new BilledAnalysisJobRequiresReconciliationError(input.jobId);
      }

      const terminalized = await transaction.analysisJob.updateMany({
        where: {
          id: input.jobId,
          status: input.expectedStatus,
          tokensSettledAt: null,
          ...(input.expectedStatus === AnalysisJobStatus.RUNNING
            ? { leaseToken: input.expectedLeaseToken }
            : {}),
        },
        data: {
          status: AnalysisJobStatus.FAILED,
          stage: null,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          tokensSettledAt: input.completedAt,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          nextPublishAt: null,
          completedAt: input.completedAt,
          lastErrorCode: input.errorCode,
          lastErrorMessage: input.errorMessage,
          errorRetryable: input.errorRetryable,
        },
      });
      if (terminalized.count !== 1) {
        throw new StaleAnalysisWorkerLeaseError(input.jobId);
      }
      if (job.reservedTokens !== null && job.reservedTokens > 0) {
        await transaction.user.update({
          where: { id: job.userId },
          data: { availableTokens: { increment: job.reservedTokens } },
        });
      }
      return true;
    });
  }
}
