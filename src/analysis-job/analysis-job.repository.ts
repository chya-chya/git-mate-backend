import { Injectable } from '@nestjs/common';
import {
  AnalysisJob,
  AnalysisJobStage,
  AnalysisJobStatus,
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
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  tokensSettledAt?: Date;
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

interface TransitionAnalysisJobRecordBase {
  jobId: string;
  toStatus: AnalysisJobStatus;
  requiredReportId?: number;
  data: AnalysisJobTransitionData;
}

export type TransitionAnalysisJobRecordInput =
  | (TransitionAnalysisJobRecordBase & {
      fromStatus: typeof AnalysisJobStatus.RUNNING;
      toStatus: typeof AnalysisJobStatus.SUCCEEDED;
      expectedLeaseToken: string;
      requiredReportId: number;
    })
  | (TransitionAnalysisJobRecordBase & {
      fromStatus: typeof AnalysisJobStatus.RUNNING;
      toStatus:
        | typeof AnalysisJobStatus.QUEUED
        | typeof AnalysisJobStatus.FAILED;
      expectedLeaseToken: string;
      requiredReportId?: never;
    })
  | (TransitionAnalysisJobRecordBase & {
      fromStatus: typeof AnalysisJobStatus.QUEUED;
      toStatus:
        | typeof AnalysisJobStatus.RUNNING
        | typeof AnalysisJobStatus.FAILED;
      expectedLeaseToken?: never;
      requiredReportId?: never;
    });

@Injectable()
export class AnalysisJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateAnalysisJobRecordInput): Promise<AnalysisJob> {
    return this.prisma.analysisJob.create({ data });
  }

  findById(jobId: string): Promise<AnalysisJob | null> {
    return this.prisma.analysisJob.findUnique({ where: { id: jobId } });
  }

  async transitionStatus(
    input: TransitionAnalysisJobRecordInput,
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
      (!Number.isInteger(input.requiredReportId) || input.requiredReportId <= 0)
    ) {
      throw new Error('A linked report is required for SUCCEEDED job updates');
    }

    const result = await this.prisma.analysisJob.updateMany({
      where: {
        id: input.jobId,
        status: input.fromStatus,
        ...(input.expectedLeaseToken === undefined
          ? {}
          : { leaseToken: input.expectedLeaseToken }),
        ...(input.requiredReportId === undefined
          ? {}
          : { report: { is: { id: input.requiredReportId } } }),
      },
      data: {
        ...input.data,
        status: input.toStatus,
      },
    });

    return result.count === 1;
  }
}
