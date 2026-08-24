import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AnalysisJobStage, AnalysisJobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AnalysisJobApiRecord,
  AnalysisJobCursor,
  analysisJobApiInclude,
} from './analysis-job-api.types';

export type AnalysisJobApiTransaction = Prisma.TransactionClient;

export interface CreateAnalysisJobApiRecordInput {
  userId: number;
  repositoryId: number;
  idempotencyKey: string;
  requestHash: string;
  sourceCursor: Date | null;
  modelVersion: string;
  promptVersion: string;
}

export interface ListOwnedAnalysisJobsInput {
  userId: number;
  repositoryId?: number;
  status?: AnalysisJobStatus;
  limit: number;
  cursor?: AnalysisJobCursor;
}

export interface AnalysisJobCreationRateLimitStatus {
  totalHits: number;
  remaining: number;
  retryAfterSeconds: number;
  isBlocked: boolean;
}

export const ANALYSIS_JOB_CREATION_RATE_LIMIT = 5;
export const ANALYSIS_JOB_CREATION_RATE_LIMIT_WINDOW_MS = 60_000;

@Injectable()
export class AnalysisJobApiRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(
    operation: (database: AnalysisJobApiTransaction) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5000,
      timeout: 10000,
    });
  }

  async acquireTransactionLock(
    scope: string,
    database: AnalysisJobApiTransaction,
  ): Promise<void> {
    const lockId = createHash('sha256').update(scope).digest().readBigInt64BE();
    await database.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
  }

  async getCreationRateLimitStatus(
    userId: number,
    database: AnalysisJobApiTransaction | PrismaService = this.prisma,
  ): Promise<AnalysisJobCreationRateLimitStatus> {
    const [record] = await database.$queryRaw<
      Array<{ totalHits: number; retryAfterSeconds: number }>
    >`
      WITH recent_jobs AS (
        SELECT "createdAt"
        FROM "analysis_jobs"
        WHERE "userId" = ${userId}
          AND "createdAt" > CURRENT_TIMESTAMP
            - ${ANALYSIS_JOB_CREATION_RATE_LIMIT_WINDOW_MS} * INTERVAL '1 millisecond'
          AND "idempotencyKey" NOT LIKE 'legacy-report:%'
          AND "idempotencyKey" NOT LIKE 'sync:%'
        ORDER BY "createdAt" ASC
        LIMIT ${ANALYSIS_JOB_CREATION_RATE_LIMIT}
      )
      SELECT
        COUNT(*)::integer AS "totalHits",
        COALESCE(
          GREATEST(
            1,
            CEIL(EXTRACT(EPOCH FROM (
              MIN("createdAt")
              + ${ANALYSIS_JOB_CREATION_RATE_LIMIT_WINDOW_MS} * INTERVAL '1 millisecond'
              - CURRENT_TIMESTAMP
            )))::integer
          ),
          ${Math.ceil(ANALYSIS_JOB_CREATION_RATE_LIMIT_WINDOW_MS / 1000)}
        ) AS "retryAfterSeconds"
      FROM recent_jobs
    `;
    const totalHits = record?.totalHits ?? 0;
    const retryAfterSeconds = record?.retryAfterSeconds ?? 60;

    return {
      totalHits,
      remaining: Math.max(0, ANALYSIS_JOB_CREATION_RATE_LIMIT - totalHits),
      retryAfterSeconds,
      isBlocked: totalHits >= ANALYSIS_JOB_CREATION_RATE_LIMIT,
    };
  }

  findByIdempotencyKey(
    userId: number,
    idempotencyKey: string,
    database: AnalysisJobApiTransaction | PrismaService = this.prisma,
  ): Promise<AnalysisJobApiRecord | null> {
    return database.analysisJob.findUnique({
      where: {
        userId_idempotencyKey: { userId, idempotencyKey },
      },
      include: analysisJobApiInclude,
    });
  }

  findOwnedRepositoryByGithubId(
    userId: number,
    githubRepoId: string,
    database: AnalysisJobApiTransaction,
  ) {
    return database.repository.findFirst({
      where: { githubRepoId, ownerId: userId },
      select: {
        id: true,
        githubRepoId: true,
        fullName: true,
        lastSyncTime: true,
        owner: { select: { availableTokens: true } },
      },
    });
  }

  create(
    input: CreateAnalysisJobApiRecordInput,
    database: AnalysisJobApiTransaction,
  ): Promise<AnalysisJobApiRecord> {
    return database.analysisJob.create({
      data: {
        ...input,
        status: AnalysisJobStatus.QUEUED,
        stage: AnalysisJobStage.WAITING,
        progress: 0,
      },
      include: analysisJobApiInclude,
    });
  }

  findOwnedById(
    userId: number,
    jobId: string,
    database: AnalysisJobApiTransaction | PrismaService = this.prisma,
  ): Promise<AnalysisJobApiRecord | null> {
    return database.analysisJob.findFirst({
      where: { id: jobId, userId },
      include: analysisJobApiInclude,
    });
  }

  listOwned(
    input: ListOwnedAnalysisJobsInput,
  ): Promise<AnalysisJobApiRecord[]> {
    const cursorBoundary: Prisma.AnalysisJobWhereInput | undefined =
      input.cursor
        ? {
            OR: [
              { createdAt: { lt: input.cursor.createdAt } },
              {
                createdAt: input.cursor.createdAt,
                id: { lt: input.cursor.id },
              },
            ],
          }
        : undefined;

    return this.prisma.analysisJob.findMany({
      where: {
        userId: input.userId,
        ...(input.repositoryId === undefined
          ? {}
          : { repositoryId: input.repositoryId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...cursorBoundary,
      },
      include: analysisJobApiInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    });
  }
}
