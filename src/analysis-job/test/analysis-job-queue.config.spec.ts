import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AnalysisJobQueueConfig } from '../queue/analysis-job-queue.config';

const QUEUE_URL =
  'https://sqs.us-east-1.amazonaws.com/000000000000/analysis-jobs.fifo';

function sqsSettings(overrides: Record<string, string> = {}) {
  return new AnalysisJobQueueConfig(
    new ConfigService({
      AWS_REGION: 'us-east-1',
      ANALYSIS_JOB_QUEUE_URL: QUEUE_URL,
      SQS_ENDPOINT: '',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_SESSION_TOKEN: '',
      ...overrides,
    }),
  ).getSqsSettings();
}

describe('AnalysisJobQueueConfig credentials', () => {
  it('signs an offline SQS request with the temporary credential session token', async () => {
    const settings = sqsSettings({
      AWS_ACCESS_KEY_ID: ' synthetic-access-key ',
      AWS_SECRET_ACCESS_KEY: ' synthetic-secret-key ',
      AWS_SESSION_TOKEN: ' synthetic-session-token ',
    });
    const messageBody = '{"schemaVersion":1,"jobId":"synthetic-job"}';
    let signedHeaders: Record<string, string> | undefined;
    const client = new SQSClient({
      ...settings,
      maxAttempts: 1,
      requestHandler: {
        handle: (request: { headers: Record<string, string> }) => {
          signedHeaders = request.headers;
          return Promise.resolve({
            response: {
              statusCode: 200,
              headers: { 'content-type': 'application/x-amz-json-1.0' },
              body: Buffer.from(
                JSON.stringify({
                  MessageId: 'synthetic-message',
                  MD5OfMessageBody: createHash('md5')
                    .update(messageBody)
                    .digest('hex'),
                }),
              ),
            },
          });
        },
      },
    });

    try {
      await expect(
        client.send(
          new SendMessageCommand({
            QueueUrl: settings.queueUrl,
            MessageBody: messageBody,
            MessageGroupId: 'synthetic-group',
            MessageDeduplicationId: 'synthetic-deduplication',
          }),
        ),
      ).resolves.toMatchObject({ MessageId: 'synthetic-message' });

      expect(settings.credentials).toMatchObject({
        accessKeyId: 'synthetic-access-key',
        secretAccessKey: 'synthetic-secret-key',
        sessionToken: 'synthetic-session-token',
      });
      expect(signedHeaders?.['x-amz-security-token']).toBe(
        'synthetic-session-token',
      );
      expect(signedHeaders?.authorization).toContain(
        'Credential=synthetic-access-key/',
      );
    } finally {
      client.destroy();
    }
  });

  it('keeps static and LocalStack credentials usable without a session token', () => {
    const settings = sqsSettings({
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_ENDPOINT: 'http://127.0.0.1:4566',
    });

    expect(settings.credentials).toEqual({
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    expect(settings.endpoint).toBe('http://127.0.0.1:4566');
  });

  it('leaves credential resolution to the SDK when explicit keys are absent', () => {
    const settings = sqsSettings();
    const client = new SQSClient(settings);

    try {
      expect(settings.credentials).toBeUndefined();
      expect(typeof client.config.credentials).toBe('function');
    } finally {
      client.destroy();
    }
  });

  it.each([
    { AWS_ACCESS_KEY_ID: 'synthetic-access-key' },
    { AWS_SECRET_ACCESS_KEY: 'synthetic-secret-key' },
  ])('rejects an incomplete explicit credential pair: %j', (credentials) => {
    expect(() => sqsSettings(credentials)).toThrow(
      'AWS access key configuration is incomplete.',
    );
  });
});
