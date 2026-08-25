import { Injectable } from '@nestjs/common';
import { AnalysisJob, AnalysisJobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AnalysisJobPublishRecord = Pick<
  AnalysisJob,
  | 'id'
  | 'status'
  | 'userId'
  | 'repositoryId'
  | 'idempotencyKey'
  | 'reservedTokens'
  | 'publishAttempts'
  | 'messagePublishedAt'
  | 'nextPublishAt'
  | 'lastErrorCode'
  | 'createdAt'
>;

const analysisJobPublishSelect = {
  id: true,
  status: true,
  userId: true,
  repositoryId: true,
  idempotencyKey: true,
  reservedTokens: true,
  publishAttempts: true,
  messagePublishedAt: true,
  nextPublishAt: true,
  lastErrorCode: true,
  createdAt: true,
} satisfies Prisma.AnalysisJobSelect;

export interface ClaimAnalysisJobPublishAttemptInput {
  job: AnalysisJobPublishRecord;
  claimedNextPublishAt: Date;
  deliveryUncertain: boolean;
}

export interface CompleteAnalysisJobPublishAttemptInput {
  job: AnalysisJobPublishRecord;
  attempt: number;
  claimedNextPublishAt: Date;
}

export interface RecordAnalysisJobPublishFailureInput extends CompleteAnalysisJobPublishAttemptInput {
  nextPublishAt: Date;
  deliveryUncertain: boolean;
  terminate: boolean;
  completedAt: Date;
}

@Injectable()
export class AnalysisJobPublishRepository {
  constructor(private readonly prisma: PrismaService) {}

  findDue(
    now: Date,
    republishAfterSeconds: number,
    maxAttempts: number,
    batchSize: number,
  ): Promise<AnalysisJobPublishRecord[]> {
    const republishCutoff = new Date(
      now.getTime() - republishAfterSeconds * 1000,
    );
    return this.prisma.analysisJob.findMany({
      where: {
        status: AnalysisJobStatus.QUEUED,
        idempotencyKey: { not: { startsWith: 'sync:' } },
        publishAttempts: { lt: maxAttempts },
        AND: [
          {
            OR: [{ nextPublishAt: null }, { nextPublishAt: { lte: now } }],
          },
          {
            OR: [
              { messagePublishedAt: null },
              { messagePublishedAt: { lte: republishCutoff } },
            ],
          },
        ],
      },
      select: analysisJobPublishSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });
  }

  async claimAttempt(
    input: ClaimAnalysisJobPublishAttemptInput,
  ): Promise<boolean> {
    const result = await this.prisma.analysisJob.updateMany({
      where: this.snapshotWhere(input.job),
      data: {
        publishAttempts: { increment: 1 },
        nextPublishAt: input.claimedNextPublishAt,
        lastErrorCode: input.deliveryUncertain
          ? 'PUBLISH_DELIVERY_UNCERTAIN'
          : 'PUBLISH_IN_PROGRESS',
        lastErrorMessage: null,
        errorRetryable: null,
      },
    });
    return result.count === 1;
  }

  async markPublished(
    input: CompleteAnalysisJobPublishAttemptInput,
    publishedAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.analysisJob.updateMany({
      where: this.claimedWhere(input),
      data: {
        messagePublishedAt: publishedAt,
        nextPublishAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        errorRetryable: null,
      },
    });
    return result.count === 1;
  }

  async recordFailure(
    input: RecordAnalysisJobPublishFailureInput,
  ): Promise<boolean> {
    const result = await this.prisma.analysisJob.updateMany({
      where: {
        ...this.claimedWhere(input),
        ...(input.terminate ? { reservedTokens: null } : {}),
      },
      data: input.terminate
        ? {
            status: AnalysisJobStatus.FAILED,
            stage: null,
            nextPublishAt: null,
            lastErrorCode: 'PUBLISH_FAILED',
            lastErrorMessage: 'The analysis job could not be published.',
            errorRetryable: true,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            tokensSettledAt: input.completedAt,
            completedAt: input.completedAt,
          }
        : {
            nextPublishAt: input.nextPublishAt,
            lastErrorCode: input.deliveryUncertain
              ? 'PUBLISH_DELIVERY_UNCERTAIN'
              : 'PUBLISH_ATTEMPT_FAILED',
            lastErrorMessage: null,
            errorRetryable: null,
          },
    });
    return result.count === 1;
  }

  private snapshotWhere(
    job: AnalysisJobPublishRecord,
  ): Prisma.AnalysisJobWhereInput {
    return {
      id: job.id,
      status: AnalysisJobStatus.QUEUED,
      publishAttempts: job.publishAttempts,
      messagePublishedAt: job.messagePublishedAt,
      nextPublishAt: job.nextPublishAt,
    };
  }

  private claimedWhere(
    input: CompleteAnalysisJobPublishAttemptInput,
  ): Prisma.AnalysisJobWhereInput {
    return {
      id: input.job.id,
      status: AnalysisJobStatus.QUEUED,
      publishAttempts: input.attempt,
      messagePublishedAt: input.job.messagePublishedAt,
      nextPublishAt: input.claimedNextPublishAt,
    };
  }
}
