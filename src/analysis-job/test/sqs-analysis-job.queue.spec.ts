import { ConfigService } from '@nestjs/config';
import {
  SendMessageCommand,
  SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { AnalysisJobQueueConfig } from '../queue/analysis-job-queue.config';
import {
  AnalysisJobSqsClientFactory,
  SqsAnalysisJobQueue,
} from '../queue/sqs-analysis-job.queue';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const TRACE_ID = '22222222-2222-4222-8222-222222222222';

describe('SqsAnalysisJobQueue', () => {
  const sentCommands: SendMessageCommand[] = [];
  const send = jest.fn<
    (
      command: SendMessageCommand,
      options: { abortSignal: AbortSignal },
    ) => Promise<SendMessageCommandOutput>
  >((command: SendMessageCommand) => {
    sentCommands.push(command);
    return Promise.resolve({ MessageId: 'message-1', $metadata: {} });
  });
  const destroy = jest.fn();
  const factory = {
    create: () => ({ send, destroy }),
  } as AnalysisJobSqsClientFactory;
  const config = new AnalysisJobQueueConfig(
    new ConfigService({
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_ENDPOINT: 'http://127.0.0.1:4566',
      ANALYSIS_JOB_QUEUE_URL:
        'http://127.0.0.1:4566/000000000000/analysis-jobs.fifo',
    }),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    sentCommands.length = 0;
  });

  it('publishes only the minimal FIFO message contract', async () => {
    const queue = new SqsAnalysisJobQueue(config, factory);

    await expect(
      queue.publish({
        jobId: JOB_ID,
        userId: 7,
        repositoryId: 17,
        traceId: TRACE_ID,
      }),
    ).resolves.toEqual({ messageId: 'message-1' });

    const command: unknown = sentCommands[0];
    expect(command).toBeInstanceOf(SendMessageCommand);
    if (!(command instanceof SendMessageCommand)) {
      throw new Error('Expected SendMessageCommand');
    }
    expect(command.input).toEqual({
      QueueUrl: 'http://127.0.0.1:4566/000000000000/analysis-jobs.fifo',
      MessageBody: JSON.stringify({ schemaVersion: 1, jobId: JOB_ID }),
      MessageGroupId: '7:17',
      MessageDeduplicationId: JOB_ID,
      MessageAttributes: {
        schemaVersion: { DataType: 'String', StringValue: '1' },
        traceId: { DataType: 'String', StringValue: TRACE_ID },
      },
    });
    const serialized = JSON.stringify(command.input);
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('repositoryId');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('prompt');
  });

  it('uses stable group and deduplication IDs for duplicate publication', async () => {
    const queue = new SqsAnalysisJobQueue(config, factory);
    const message = {
      jobId: JOB_ID,
      userId: 7,
      repositoryId: 17,
      traceId: TRACE_ID,
    };

    await queue.publish(message);
    await queue.publish(message);

    const inputs = sentCommands.map((sentCommand) => {
      const command: unknown = sentCommand;
      if (!(command instanceof SendMessageCommand)) {
        throw new Error('Expected SendMessageCommand');
      }
      return command.input;
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.MessageGroupId).toBe(inputs[1]?.MessageGroupId);
    expect(inputs[0]?.MessageDeduplicationId).toBe(
      inputs[1]?.MessageDeduplicationId,
    );
  });

  it('starts without SQS settings and validates them only on publish', async () => {
    const missingConfig = new AnalysisJobQueueConfig(new ConfigService({}));
    const queue = new SqsAnalysisJobQueue(missingConfig, factory);

    await expect(
      queue.publish({
        jobId: JOB_ID,
        userId: 7,
        repositoryId: 17,
        traceId: TRACE_ID,
      }),
    ).rejects.toThrow('AWS_REGION is required');
  });

  it.each([
    { jobId: 'not-a-uuid', userId: 7, repositoryId: 17, traceId: TRACE_ID },
    { jobId: JOB_ID, userId: 0, repositoryId: 17, traceId: TRACE_ID },
    { jobId: JOB_ID, userId: 7, repositoryId: -1, traceId: TRACE_ID },
    { jobId: JOB_ID, userId: 7, repositoryId: 17, traceId: '\nsecret' },
  ])('rejects invalid message identifiers', async (message) => {
    const queue = new SqsAnalysisJobQueue(config, factory);

    await expect(queue.publish(message)).rejects.toThrow('invalid');
    expect(send).not.toHaveBeenCalled();
  });
});
