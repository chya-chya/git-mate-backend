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

export interface AnalysisJobQueue {
  publish(
    message: AnalysisJobQueueMessage,
  ): Promise<AnalysisJobQueuePublishResult>;
}
