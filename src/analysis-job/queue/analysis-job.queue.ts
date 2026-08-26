export const ANALYSIS_JOB_QUEUE = Symbol('ANALYSIS_JOB_QUEUE');

export interface AnalysisJobQueueMessage {
  jobId: string;
  userId: number;
  repositoryId: number;
  traceId: string;
}

export interface AnalysisJobQueuePublishResult {
  messageId?: string;
}

export class AnalysisJobQueueRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = AnalysisJobQueueRejectedError.name;
  }
}

export interface AnalysisJobQueue {
  publish(
    message: AnalysisJobQueueMessage,
  ): Promise<AnalysisJobQueuePublishResult>;
}
