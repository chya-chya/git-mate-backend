import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import {
  SendMessageCommand,
  SendMessageCommandOutput,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  AnalysisJobQueue,
  AnalysisJobQueueMessage,
  AnalysisJobQueuePublishResult,
} from './analysis-job.queue';
import { AnalysisJobQueueConfig } from './analysis-job-queue.config';

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SQS_REQUEST_TIMEOUT_MS = 5_000;

interface SqsClientPort {
  send(
    command: SendMessageCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<SendMessageCommandOutput>;
  destroy(): void;
}

export interface AnalysisJobSqsClientFactory {
  create(): SqsClientPort;
}

export const ANALYSIS_JOB_SQS_CLIENT_FACTORY = Symbol(
  'ANALYSIS_JOB_SQS_CLIENT_FACTORY',
);

@Injectable()
export class SqsAnalysisJobQueue implements AnalysisJobQueue, OnModuleDestroy {
  private client?: SqsClientPort;

  constructor(
    private readonly config: AnalysisJobQueueConfig,
    @Optional()
    @Inject(ANALYSIS_JOB_SQS_CLIENT_FACTORY)
    private readonly clientFactory?: AnalysisJobSqsClientFactory,
  ) {}

  async publish(
    message: AnalysisJobQueueMessage,
  ): Promise<AnalysisJobQueuePublishResult> {
    this.validateMessage(message);
    const settings = this.config.getSqsSettings();
    const command = new SendMessageCommand({
      QueueUrl: settings.queueUrl,
      MessageBody: JSON.stringify({ schemaVersion: 1, jobId: message.jobId }),
      MessageGroupId: `${message.userId}:${message.repositoryId}`,
      MessageDeduplicationId: message.jobId,
      MessageAttributes: {
        schemaVersion: {
          DataType: 'String',
          StringValue: '1',
        },
        traceId: {
          DataType: 'String',
          StringValue: message.traceId,
        },
      },
    });
    const result = await this.getClient().send(command, {
      abortSignal: AbortSignal.timeout(SQS_REQUEST_TIMEOUT_MS),
    });
    return { messageId: result.MessageId };
  }

  onModuleDestroy(): void {
    this.client?.destroy();
  }

  private getClient(): SqsClientPort {
    if (this.client) {
      return this.client;
    }
    if (this.clientFactory) {
      this.client = this.clientFactory.create();
      return this.client;
    }

    const settings = this.config.getSqsSettings();
    this.client = new SQSClient({
      region: settings.region,
      endpoint: settings.endpoint,
      credentials: settings.credentials,
      maxAttempts: 2,
    });
    return this.client;
  }

  private validateMessage(message: AnalysisJobQueueMessage): void {
    if (!JOB_ID_PATTERN.test(message.jobId)) {
      throw new Error('Analysis job queue message has an invalid jobId.');
    }
    if (!Number.isInteger(message.userId) || message.userId <= 0) {
      throw new Error('Analysis job queue message has an invalid userId.');
    }
    if (!Number.isInteger(message.repositoryId) || message.repositoryId <= 0) {
      throw new Error(
        'Analysis job queue message has an invalid repositoryId.',
      );
    }
    if (!TRACE_ID_PATTERN.test(message.traceId)) {
      throw new Error('Analysis job queue message has an invalid traceId.');
    }
  }
}
