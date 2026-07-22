import { Injectable } from '@nestjs/common';
import { AnalysisJob, AnalysisJobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AnalysisJobTransitionData = Pick<
  Prisma.AnalysisJobUpdateManyMutationInput,
  | 'stage'
  | 'progress'
  | 'estimatedTokens'
  | 'reservedTokens'
  | 'promptTokens'
  | 'completionTokens'
  | 'totalTokens'
  | 'tokensSettledAt'
  | 'usage'
  | 'publishAttempts'
  | 'messagePublishedAt'
  | 'nextPublishAt'
  | 'attemptCount'
  | 'maxAttempts'
  | 'leaseToken'
  | 'leaseExpiresAt'
  | 'heartbeatAt'
  | 'lastErrorCode'
  | 'lastErrorMessage'
  | 'errorRetryable'
  | 'startedAt'
  | 'completedAt'
>;

export interface TransitionAnalysisJobRecordInput {
  jobId: string;
  fromStatus: AnalysisJobStatus;
  toStatus: AnalysisJobStatus;
  expectedLeaseToken?: string | null;
  data?: AnalysisJobTransitionData;
}

@Injectable()
export class AnalysisJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.AnalysisJobUncheckedCreateInput): Promise<AnalysisJob> {
    return this.prisma.analysisJob.create({ data });
  }

  findById(jobId: string): Promise<AnalysisJob | null> {
    return this.prisma.analysisJob.findUnique({ where: { id: jobId } });
  }

  async transitionStatus(
    input: TransitionAnalysisJobRecordInput,
  ): Promise<boolean> {
    const result = await this.prisma.analysisJob.updateMany({
      where: {
        id: input.jobId,
        status: input.fromStatus,
        ...(input.expectedLeaseToken !== undefined
          ? { leaseToken: input.expectedLeaseToken }
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
