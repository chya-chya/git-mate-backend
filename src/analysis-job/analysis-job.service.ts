import { Injectable } from '@nestjs/common';
import {
  AnalysisJob,
  AnalysisJobStage,
  AnalysisJobStatus,
} from '@prisma/client';
import {
  AnalysisJobRepository,
  AnalysisJobTransitionData,
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

export interface CreateAnalysisJobInput {
  userId: number;
  repositoryId: number;
  idempotencyKey: string;
  requestHash: string;
  modelVersion: string;
  promptVersion: string;
  sourceCursor?: Date | null;
}

export interface TransitionAnalysisJobInput {
  jobId: string;
  fromStatus: AnalysisJobStatus;
  toStatus: AnalysisJobStatus;
  expectedLeaseToken?: string | null;
  data?: AnalysisJobTransitionData;
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
    return this.repository.create({
      ...input,
      status: AnalysisJobStatus.QUEUED,
      stage: AnalysisJobStage.WAITING,
      progress: 0,
    });
  }

  findById(jobId: string): Promise<AnalysisJob | null> {
    return this.repository.findById(jobId);
  }

  async transition(input: TransitionAnalysisJobInput): Promise<void> {
    if (!canTransitionAnalysisJob(input.fromStatus, input.toStatus)) {
      throw new InvalidAnalysisJobTransitionError(
        input.fromStatus,
        input.toStatus,
      );
    }

    const transitioned = await this.repository.transitionStatus(input);
    if (!transitioned) {
      throw new StaleAnalysisJobTransitionError(input.jobId, input.fromStatus);
    }
  }
}
