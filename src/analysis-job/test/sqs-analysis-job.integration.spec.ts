import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
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
});
