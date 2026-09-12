import type { Context, SQSEvent } from 'aws-lambda';
import { AnalysisWorkerService } from '../analysis-worker.service';
import { createAnalysisWorkerHandler } from '../analysis-worker.handler';

describe('Analysis Worker Lambda handler', () => {
  it('reuses the application context and disables waiting for the event loop', async () => {
    const processBatch = jest.fn().mockResolvedValue({ batchItemFailures: [] });
    const applicationFactory = jest.fn().mockResolvedValue({
      get: (token: unknown) => {
        expect(token).toBe(AnalysisWorkerService);
        return { processBatch };
      },
    });
    const handler = createAnalysisWorkerHandler(applicationFactory);
    const context = createContext();
    const event = createEvent(['message-1']);

    await handler(event, context, jest.fn());
    await handler(event, context, jest.fn());

    expect(applicationFactory).toHaveBeenCalledTimes(1);
    expect(processBatch).toHaveBeenCalledTimes(2);
    expect(context.callbackWaitsForEmptyEventLoop).toBe(false);
  });

  it('returns every message ID when application bootstrap fails', async () => {
    const handler = createAnalysisWorkerHandler(() =>
      Promise.reject(new Error('bootstrap unavailable')),
    );

    await expect(
      handler(
        createEvent(['message-1', 'message-2']),
        createContext(),
        jest.fn(),
      ),
    ).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: 'message-1' },
        { itemIdentifier: 'message-2' },
      ],
    });
  });

  function createContext(): Context {
    return {
      callbackWaitsForEmptyEventLoop: true,
      functionName: 'analysis-worker',
      functionVersion: '$LATEST',
      invokedFunctionArn: 'arn:aws:lambda:us-east-1:000:function:worker',
      memoryLimitInMB: '1024',
      awsRequestId: 'request-1',
      logGroupName: 'group',
      logStreamName: 'stream',
      getRemainingTimeInMillis: () => 60_000,
      done: jest.fn(),
      fail: jest.fn(),
      succeed: jest.fn(),
    };
  }

  function createEvent(messageIds: string[]): SQSEvent {
    return {
      Records: messageIds.map((messageId) => ({
        messageId,
        receiptHandle: `receipt-${messageId}`,
        body: '{}',
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '0',
          SenderId: 'sender',
          ApproximateFirstReceiveTimestamp: '0',
        },
        messageAttributes: {},
        md5OfBody: 'checksum',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:000:queue.fifo',
        awsRegion: 'us-east-1',
      })),
    };
  }
});
