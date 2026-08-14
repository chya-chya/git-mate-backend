import { Injectable } from '@nestjs/common';
import {
  AnalysisJob,
  AnalysisJobStage,
  AnalysisJobStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateAnalysisJobRecordInput {
  userId: number;
  repositoryId: number;
  idempotencyKey: string;
  requestHash: string;
  modelVersion: string;
  promptVersion: string;
  sourceCursor?: Date | null;
  status: AnalysisJobStatus;
  stage: AnalysisJobStage;
  progress: number;
}

export interface AnalysisJobTransitionData {
  stage?: AnalysisJobStage | null;
  progress?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  tokensSettledAt?: Date | null;
  providerRequestIds?: string[];
  nextPublishAt?: Date | null;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  heartbeatAt?: Date | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  errorRetryable?: boolean | null;
  startedAt?: Date;
  completedAt?: Date;
}

export type AnalysisJobDatabase = Pick<Prisma.TransactionClient, 'analysisJob'>;

export type RunningAnalysisJobContext = Pick<
  AnalysisJob,
  | 'id'
  | 'userId'
  | 'repositoryId'
  | 'modelVersion'
  | 'promptVersion'
  | 'reservedTokens'
  | 'promptTokens'
  | 'completionTokens'
  | 'totalTokens'
  | 'providerRequestIds'
>;

export interface ReserveAnalysisJobTokensRecordInput {
  jobId: string;
  expectedLeaseToken: string;
  expectedUserId: number;
  expectedRepositoryId: number;
  estimatedTokens: number;
  reservedTokens: number;
}

export interface RecordAnalysisJobProviderChargeInput {
  jobId: string;
  expectedLeaseToken: string;
  expectedUserId: number;
  expectedRepositoryId: number;
  expectedReservedTokens: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  providerRequestId: string;
}

interface TransitionAnalysisJobRecordBase {
  jobId: string;
  toStatus: AnalysisJobStatus;
  requiredReportId?: number;
  requiredUserId?: number;
  requiredRepositoryId?: number;
  requiredReservedTokens?: number | null;
  data: AnalysisJobTransitionData;
}

export type TransitionAnalysisJobRecordInput =
  | (TransitionAnalysisJobRecordBase & {
      fromStatus: typeof AnalysisJobStatus.RUNNING;
      toStatus: typeof AnalysisJobStatus.SUCCEEDED;
      expectedLeaseToken: string;
      requiredReportId: number;
      requiredUserId: number;
      requiredRepositoryId: number;
      requiredReservedTokens: number;
    })
  | (TransitionAnalysisJobRecordBase & {
      fromStatus: typeof AnalysisJobStatus.RUNNING;
      toStatus: typeof AnalysisJobStatus.QUEUED;
      expectedLeaseToken: string;
      requiredReportId?: never;
      requiredUserId?: never;
      requiredRepositoryId?: never;
      requiredReservedTokens?: never;
    })
  | (TransitionAnalysisJobRecordBase & {
      fromStatus: typeof AnalysisJobStatus.RUNNING;
      toStatus: typeof AnalysisJobStatus.FAILED;
      expectedLeaseToken: string;
      requiredReportId?: never;
      requiredUserId: number;
      requiredRepositoryId: number;
      requiredReservedTokens: number | null;
    })
  | (TransitionAnalysisJobRecordBase & {
      fromStatus: typeof AnalysisJobStatus.QUEUED;
      toStatus:
        | typeof AnalysisJobStatus.RUNNING
        | typeof AnalysisJobStatus.FAILED;
      expectedLeaseToken?: never;
      requiredReportId?: never;
      requiredUserId?: never;
      requiredRepositoryId?: never;
      requiredReservedTokens?: never;
    });

@Injectable()
export class AnalysisJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    data: CreateAnalysisJobRecordInput,
    database: AnalysisJobDatabase = this.prisma,
  ): Promise<AnalysisJob> {
    return database.analysisJob.create({ data });
  }

  findById(
    jobId: string,
    database: AnalysisJobDatabase = this.prisma,
  ): Promise<AnalysisJob | null> {
    return database.analysisJob.findUnique({ where: { id: jobId } });
  }

  findRunningByLease(
    jobId: string,
    leaseToken: string,
    database: AnalysisJobDatabase = this.prisma,
  ): Promise<RunningAnalysisJobContext | null> {
    return database.analysisJob.findFirst({
      where: {
        id: jobId,
        status: AnalysisJobStatus.RUNNING,
        leaseToken,
      },
      select: {
        id: true,
        userId: true,
        repositoryId: true,
        modelVersion: true,
        promptVersion: true,
        reservedTokens: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        providerRequestIds: true,
      },
    });
  }

  async reserveTokens(
    input: ReserveAnalysisJobTokensRecordInput,
    database: AnalysisJobDatabase = this.prisma,
  ): Promise<boolean> {
    const result = await database.analysisJob.updateMany({
      where: {
        id: input.jobId,
        status: AnalysisJobStatus.RUNNING,
        leaseToken: input.expectedLeaseToken,
        userId: input.expectedUserId,
        repositoryId: input.expectedRepositoryId,
        reservedTokens: null,
        tokensSettledAt: null,
      },
      data: {
        stage: AnalysisJobStage.ANALYZING,
        estimatedTokens: input.estimatedTokens,
        reservedTokens: input.reservedTokens,
      },
    });
    return result.count === 1;
  }

  async recordProviderCharge(
    input: RecordAnalysisJobProviderChargeInput,
    database: AnalysisJobDatabase = this.prisma,
  ): Promise<boolean> {
    const result = await database.analysisJob.updateMany({
      where: {
        id: input.jobId,
        status: AnalysisJobStatus.RUNNING,
        leaseToken: input.expectedLeaseToken,
        userId: input.expectedUserId,
        repositoryId: input.expectedRepositoryId,
        reservedTokens: input.expectedReservedTokens,
        tokensSettledAt: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        providerRequestIds: { isEmpty: true },
      },
      data: {
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: input.totalTokens,
        providerRequestIds: [input.providerRequestId],
      },
    });
    return result.count === 1;
  }

  async transitionStatus(
    input: TransitionAnalysisJobRecordInput,
    database: AnalysisJobDatabase = this.prisma,
  ): Promise<boolean> {
    if (
      input.fromStatus === AnalysisJobStatus.RUNNING &&
      (typeof input.expectedLeaseToken !== 'string' ||
        input.expectedLeaseToken.trim().length === 0)
    ) {
      throw new Error('A lease fence is required for RUNNING job updates');
    }
    if (
      input.toStatus === AnalysisJobStatus.SUCCEEDED &&
      (!Number.isInteger(input.requiredReportId) ||
        input.requiredReportId <= 0 ||
        !Number.isInteger(input.requiredUserId) ||
        input.requiredUserId <= 0 ||
        !Number.isInteger(input.requiredRepositoryId) ||
        input.requiredRepositoryId <= 0)
    ) {
      throw new Error(
        'A linked report, user, and repository are required for SUCCEEDED job updates',
      );
    }

    const result = await database.analysisJob.updateMany({
      where: {
        id: input.jobId,
        status: input.fromStatus,
        ...(input.expectedLeaseToken === undefined
          ? {}
          : { leaseToken: input.expectedLeaseToken }),
        ...(input.requiredReportId === undefined
          ? {}
          : { report: { is: { id: input.requiredReportId } } }),
        ...(input.requiredUserId === undefined
          ? {}
          : { userId: input.requiredUserId }),
        ...(input.requiredRepositoryId === undefined
          ? {}
          : { repositoryId: input.requiredRepositoryId }),
        ...(input.requiredReservedTokens === undefined
          ? {}
          : { reservedTokens: input.requiredReservedTokens }),
        ...(input.toStatus === AnalysisJobStatus.SUCCEEDED ||
        input.toStatus === AnalysisJobStatus.FAILED
          ? { tokensSettledAt: null }
          : {}),
      },
      data: {
        ...input.data,
        status: input.toStatus,
      },
    });

    return result.count === 1;
  }
}
