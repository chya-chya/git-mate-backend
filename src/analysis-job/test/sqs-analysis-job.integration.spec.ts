import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { AnalysisJobStatus, Prisma, PrismaClient } from '@prisma/client';
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { SQSRecord } from 'aws-lambda';
import {
  AnalysisJobExecutionOutcome,
  AnalysisJobRunnerService,
} from '../../analysis/analysis.service';
import { AnalysisWorkerErrorClassifier } from '../../analysis-worker/analysis-worker-error-classifier';
import { AnalysisWorkerRepository } from '../../analysis-worker/analysis-worker.repository';
import { AnalysisWorkerService } from '../../analysis-worker/analysis-worker.service';
import { RepositoryCollectionService } from '../../collection/repository-collection.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalysisJobRepository } from '../analysis-job.repository';
import {
  AnalysisJobFailureCode,
  AnalysisJobService,
} from '../analysis-job.service';
import {
  ClaimAnalysisJobPublishAttemptInput,
  AnalysisJobPublishRecord,
  AnalysisJobPublishRepository,
  RecordAnalysisJobPublishFailureInput,
} from '../analysis-job-publish.repository';
import {
  AnalysisJobPublishOutcome,
  AnalysisJobPublisherService,
} from '../analysis-job-publisher.service';
import { AnalysisJobReconcilerService } from '../analysis-job-reconciler.service';
import { AnalysisJobQueueConfig } from '../queue/analysis-job-queue.config';
import { AnalysisJobQueue } from '../queue/analysis-job.queue';
import { SqsAnalysisJobQueue } from '../queue/sqs-analysis-job.queue';

const runSqsIntegrationTests = process.env.RUN_SQS_INTEGRATION_TESTS === 'true';
const describeSqs = runSqsIntegrationTests ? describe : describe.skip;

describeSqs('Analysis Job LocalStack SQS integration', () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let client: SQSClient;
  let config: AnalysisJobQueueConfig;
  let queue: SqsAnalysisJobQueue;
  let queueUrl: string;
  const createdUserIds: number[] = [];

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    queueUrl = process.env.ANALYSIS_JOB_QUEUE_URL ?? '';
    if (!databaseUrl || !queueUrl) {
      throw new Error(
        'TEST_DATABASE_URL and ANALYSIS_JOB_QUEUE_URL are required for SQS integration tests.',
      );
    }
    config = new AnalysisJobQueueConfig(new ConfigService(process.env));
    queue = new SqsAnalysisJobQueue(config);
    const sqsSettings = config.getSqsSettings();
    client = new SQSClient({
      region: sqsSettings.region,
      endpoint: sqsSettings.endpoint,
      credentials: sqsSettings.credentials,
      maxAttempts: 2,
    });
    await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));

    pool = new Pool({ connectionString: databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    await prisma.$connect();
    const staleUsers = await prisma.user.findMany({
      where: { githubId: { startsWith: 'sqs-' } },
      select: { id: true },
    });
    await deleteDatabaseUsers(staleUsers.map((user) => user.id));
  });

  afterAll(async () => {
    await drainQueue();
    await cleanupDatabaseUsers();
    queue?.onModuleDestroy();
    client?.destroy();
    await prisma?.$disconnect();
    await pool?.end();
  });

  afterEach(async () => {
    await drainQueue();
    await cleanupDatabaseUsers();
  });

  it('publishes and receives the exact minimal FIFO contract', async () => {
    const jobId = randomUUID();
    const traceId = randomUUID();

    await queue.publish({ jobId, userId: 7, repositoryId: 17, traceId });
    const messages = await receiveMessages();

    expect(messages).toHaveLength(1);
    expect(messages[0]?.Body).toBe(JSON.stringify({ schemaVersion: 1, jobId }));
    expect(messages[0]?.MessageAttributes?.schemaVersion?.StringValue).toBe(
      '1',
    );
    expect(messages[0]?.MessageAttributes?.traceId?.StringValue).toBe(traceId);
  });

  it('deduplicates two publications of the same Job ID', async () => {
    const jobId = randomUUID();
    const message = {
      jobId,
      userId: 8,
      repositoryId: 18,
      traceId: randomUUID(),
    };

    await queue.publish(message);
    await queue.publish({ ...message, traceId: randomUUID() });

    await expect(receiveMessages()).resolves.toHaveLength(1);
  });

  it('delivers the published contract to the Worker while the public flag is false', async () => {
    const job = await createDatabaseJob('worker-delivery');
    const traceId = randomUUID();
    await queue.publish({
      jobId: job.id,
      userId: job.userId,
      repositoryId: job.repositoryId,
      traceId,
    });
    const [message] = await receiveMessages();
    if (!message) {
      throw new Error('Expected a LocalStack message.');
    }

    const analysisJobService = new AnalysisJobService(
      new AnalysisJobRepository(prisma),
    );
    const runAnalysisJob = jest.fn(
      async (
        _data: unknown,
        context: { jobId: string; leaseToken: string },
        completionAction: (
          transaction: Prisma.TransactionClient,
        ) => Promise<unknown>,
      ) => {
        const running = await prisma.analysisJob.findUniqueOrThrow({
          where: { id: context.jobId },
        });
        const completedAt = new Date();
        await prisma.$transaction(async (transaction) => {
          await analysisJobService.transition(
            {
              jobId: context.jobId,
              fromStatus: AnalysisJobStatus.RUNNING,
              toStatus: AnalysisJobStatus.FAILED,
              expectedLeaseToken: context.leaseToken,
              expectedUserId: running.userId,
              expectedRepositoryId: running.repositoryId,
              expectedReservedTokens: null,
              data: {
                completedAt,
                tokensSettledAt: completedAt,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                providerRequestIds: [],
                errorCode: AnalysisJobFailureCode.NO_ANALYZABLE_DATA,
                errorRetryable: false,
              },
            },
            transaction,
          );
          await completionAction(transaction);
        });
        return { outcome: AnalysisJobExecutionOutcome.NO_ANALYZABLE_DATA };
      },
    );
    const repositoryCollection = {
      collect: jest.fn().mockResolvedValue({
        githubRepoId: 'worker-delivery',
        owner: 'integration',
        repo: 'worker-delivery',
        targetUser: 'sqs-worker-delivery',
        pullRequests: [],
      }),
    };
    const worker = new AnalysisWorkerService(
      new AnalysisWorkerRepository(prisma as unknown as PrismaService),
      repositoryCollection as unknown as RepositoryCollectionService,
      { runAnalysisJob } as unknown as AnalysisJobRunnerService,
      new AnalysisWorkerErrorClassifier(),
      new ConfigService({
        ASYNC_ANALYSIS_ENABLED: 'false',
        ANALYSIS_WORKER_LEASE_SECONDS: '900',
      }),
    );

    await expect(
      worker.processBatch([toSqsRecord(message)], 'localstack-request'),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(runAnalysisJob).toHaveBeenCalledTimes(1);
    await expect(
      prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: AnalysisJobStatus.FAILED,
      lastErrorCode: AnalysisJobFailureCode.NO_ANALYZABLE_DATA,
    });
  });

  it('recovers a committed DB Job after an unreachable endpoint', async () => {
    const job = await createDatabaseJob('connection-recovery');
    const repository = new AnalysisJobPublishRepository(
      prisma as unknown as PrismaService,
    );
    const faultQueue: AnalysisJobQueue = {
      publish: () => Promise.reject(new Error('fault injection')),
    };
    const failedPublisher = new AnalysisJobPublisherService(
      repository,
      faultQueue,
      config,
    );
    const failedAt = new Date('2026-08-25T01:00:00.000Z');

    await expect(
      failedPublisher.publish(job, {
        allowRepublish: false,
        now: failedAt,
        traceId: randomUUID(),
        random: 0,
      }),
    ).resolves.toBe(AnalysisJobPublishOutcome.DEFERRED);
    await expect(
      prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: 'QUEUED',
      publishAttempts: 1,
      messagePublishedAt: null,
      nextPublishAt: new Date('2026-08-25T01:01:00.000Z'),
    });

    const recoveredPublisher = new AnalysisJobPublisherService(
      repository,
      queue,
      config,
    );
    const reconciler = new AnalysisJobReconcilerService(
      repository,
      recoveredPublisher,
      config,
    );
    await expect(
      reconciler.runOnce(new Date('2026-08-25T01:02:00.000Z')),
    ).resolves.toMatchObject({ published: 1 });
    await expect(receiveMessages()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Body: JSON.stringify({ schemaVersion: 1, jobId: job.id }),
        }),
      ]),
    );
  });

  it('allows safe republish after SQS success and DB acknowledgement failure', async () => {
    const job = await createDatabaseJob('acknowledgement-recovery');
    const durableRepository = new AnalysisJobPublishRepository(
      prisma as unknown as PrismaService,
    );
    const failingAcknowledgementRepository = {
      claimAttempt: (input: ClaimAnalysisJobPublishAttemptInput) =>
        durableRepository.claimAttempt(input),
      markPublished: () => Promise.reject(new Error('fault injection')),
      recordFailure: (input: RecordAnalysisJobPublishFailureInput) =>
        durableRepository.recordFailure(input),
    } as unknown as AnalysisJobPublishRepository;
    const publisher = new AnalysisJobPublisherService(
      failingAcknowledgementRepository,
      queue,
      config,
    );
    const firstAttemptAt = new Date('2026-08-25T02:00:00.000Z');

    await expect(
      publisher.publish(job, {
        allowRepublish: false,
        now: firstAttemptAt,
        traceId: randomUUID(),
      }),
    ).resolves.toBe(AnalysisJobPublishOutcome.DEFERRED);
    await expect(
      prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: 'QUEUED',
      publishAttempts: 1,
      messagePublishedAt: null,
      lastErrorCode: 'PUBLISH_IN_PROGRESS',
    });

    const reconciler = new AnalysisJobReconcilerService(
      durableRepository,
      new AnalysisJobPublisherService(durableRepository, queue, config),
      config,
    );
    await reconciler.runOnce(new Date('2026-08-25T02:02:00.000Z'));

    await expect(
      prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: 'QUEUED',
      publishAttempts: 2,
      lastErrorCode: null,
    });
    expect(
      (await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } }))
        .messagePublishedAt,
    ).not.toBeNull();
  });

  async function createDatabaseJob(
    suffix: string,
  ): Promise<AnalysisJobPublishRecord> {
    const unique = randomUUID();
    const user = await prisma.user.create({
      data: {
        githubId: `sqs-${suffix}-${unique}`,
        username: `sqs-${suffix}`,
      },
    });
    createdUserIds.push(user.id);
    const repository = await prisma.repository.create({
      data: {
        githubRepoId: `sqs-repository-${unique}`,
        fullName: `integration/${suffix}`,
        ownerId: user.id,
      },
    });
    return prisma.analysisJob.create({
      data: {
        userId: user.id,
        repositoryId: repository.id,
        idempotencyKey: `sqs-${suffix}-${unique}`,
        requestHash: 'a'.repeat(64),
      },
      select: {
        id: true,
        status: true,
        userId: true,
        repositoryId: true,
        idempotencyKey: true,
        reservedTokens: true,
        publishAttempts: true,
        messagePublishedAt: true,
        nextPublishAt: true,
        lastErrorCode: true,
        createdAt: true,
      },
    });
  }

  async function receiveMessages() {
    const result = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    return result.Messages ?? [];
  }

  async function drainQueue(): Promise<void> {
    if (!client || !queueUrl) {
      return;
    }
    for (;;) {
      const messages = await receiveMessages();
      if (messages.length === 0) {
        return;
      }
      for (const message of messages) {
        if (message.ReceiptHandle) {
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
      }
    }
  }

  async function cleanupDatabaseUsers(): Promise<void> {
    if (!prisma || createdUserIds.length === 0) {
      return;
    }
    const userIds = [...createdUserIds];
    await deleteDatabaseUsers(userIds);
    createdUserIds.length = 0;
  }

  async function deleteDatabaseUsers(userIds: number[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    await prisma.analysisJob.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.repository.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  function toSqsRecord(
    message: Awaited<ReturnType<typeof receiveMessages>>[number],
  ): SQSRecord {
    if (!message.MessageId || !message.ReceiptHandle || !message.Body) {
      throw new Error('LocalStack returned an incomplete SQS message.');
    }
    const messageAttributes = Object.fromEntries(
      Object.entries(message.MessageAttributes ?? {}).map(([key, value]) => [
        key,
        {
          stringValue: value.StringValue,
          binaryValue: value.BinaryValue,
          stringListValues: value.StringListValues ?? [],
          binaryListValues: value.BinaryListValues ?? [],
          dataType: value.DataType ?? 'String',
        },
      ]),
    );
    return {
      messageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body,
      attributes: {
        ApproximateReceiveCount:
          message.Attributes?.ApproximateReceiveCount ?? '1',
        SentTimestamp: message.Attributes?.SentTimestamp ?? '0',
        SenderId: message.Attributes?.SenderId ?? 'localstack',
        ApproximateFirstReceiveTimestamp:
          message.Attributes?.ApproximateFirstReceiveTimestamp ?? '0',
        SequenceNumber: message.Attributes?.SequenceNumber,
        MessageGroupId: message.Attributes?.MessageGroupId,
        MessageDeduplicationId: message.Attributes?.MessageDeduplicationId,
        AWSTraceHeader: message.Attributes?.AWSTraceHeader,
      },
      messageAttributes,
      md5OfBody: message.MD5OfBody ?? '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:queue.fifo',
      awsRegion: 'us-east-1',
    };
  }
});
