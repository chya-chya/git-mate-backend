import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { AnalysisJobStatus, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StatService } from '../../analysis/stat.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalysisJobApiRepository } from '../analysis-job-api.repository';
import { AnalysisJobApiService } from '../analysis-job-api.service';
import { AnalysisJobResponseMapper } from '../analysis-job-response.mapper';
import {
  ActiveAnalysisJobExistsError,
  AnalysisJobRepository,
} from '../analysis-job.repository';
import {
  AnalysisJobFailureCode,
  AnalysisJobService,
  StaleAnalysisJobTransitionError,
} from '../analysis-job.service';
import {
  AnalysisJobPublishOutcome,
  AnalysisJobPublisherService,
} from '../analysis-job-publisher.service';
import {
  AnalysisJobPublishRecord,
  AnalysisJobPublishRepository,
} from '../analysis-job-publish.repository';
import { AnalysisJobReconcilerService } from '../analysis-job-reconciler.service';
import { AnalysisJobQueueConfig } from '../queue/analysis-job-queue.config';
import { AnalysisJobQueue } from '../queue/analysis-job.queue';

const runDatabaseIntegrationTests =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === 'true';
const describeDatabase = runDatabaseIntegrationTests ? describe : describe.skip;

describeDatabase('AnalysisJob PostgreSQL invariants', () => {
  let pool: Pool;
  let prismaPool: Pool;
  let prisma: PrismaClient;
  let analysisJobService: AnalysisJobService;
  let analysisJobApiService: AnalysisJobApiService;
  let analysisJobPublishRepository: AnalysisJobPublishRepository;
  let userId: number;
  let repositoryId: number;
  const publisher = {
    publishAcceptedJob: jest
      .fn()
      .mockResolvedValue(AnalysisJobPublishOutcome.SKIPPED),
  } as unknown as AnalysisJobPublisherService;

  const settlement = {
    completedAt: new Date('2026-08-04T00:00:00.000Z'),
    tokensSettledAt: new Date('2026-08-04T00:00:00.000Z'),
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    providerRequestIds: [] as string[],
  };

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        'TEST_DATABASE_URL is required when RUN_DATABASE_INTEGRATION_TESTS=true',
      );
    }
    process.env.DATABASE_URL = databaseUrl;
    pool = new Pool({ connectionString: databaseUrl });

    const migrationDirectories = [
      '20260416053847_init_standard',
      '20260611040000_add_github_installations',
      '20260618052000_add_user_status',
    ];
    for (const directory of migrationDirectories) {
      const sql = readFileSync(
        resolve('prisma/migrations', directory, 'migration.sql'),
        'utf8',
      );
      await pool.query(sql);
    }

    const userResult = await pool.query<{ id: number }>(
      `INSERT INTO "users" ("githubId", "username", "updatedAt")
       VALUES ($1, $2, NOW()) RETURNING "id"`,
      ['integration-user', 'integration-user'],
    );
    userId = userResult.rows[0].id;
    const repositoryResult = await pool.query<{ id: number }>(
      `INSERT INTO "repositories" ("githubRepoId", "fullName", "ownerId")
       VALUES ($1, $2, $3) RETURNING "id"`,
      ['integration-repository', 'owner/repository', userId],
    );
    repositoryId = repositoryResult.rows[0].id;
    await pool.query(
      `INSERT INTO "user_stats" ("userId", "updatedAt") VALUES ($1, NOW())`,
      [userId],
    );
    await pool.query(
      `INSERT INTO "analysis_reports" ("userId", "repositoryId", "syncTime")
       VALUES ($1, $2, $3), ($1, $2, $4)`,
      [
        userId,
        repositoryId,
        new Date('2026-08-01T00:00:00.000Z'),
        new Date('2026-08-02T00:00:00.000Z'),
      ],
    );

    const ledgerMigration = readFileSync(
      resolve(
        'prisma/migrations/20260722080000_add_analysis_job_ledger/migration.sql',
      ),
      'utf8',
    );
    await pool.query(ledgerMigration);

    prismaPool = new Pool({ connectionString: databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(prismaPool) });
    await prisma.$connect();
    const analysisJobRepository = new AnalysisJobRepository(prisma);
    analysisJobService = new AnalysisJobService(analysisJobRepository);
    analysisJobPublishRepository = new AnalysisJobPublishRepository(
      prisma as unknown as PrismaService,
    );
    analysisJobApiService = new AnalysisJobApiService(
      new AnalysisJobApiRepository(prisma as unknown as PrismaService),
      new AnalysisJobResponseMapper(),
      analysisJobRepository,
      publisher,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await prismaPool?.end();
    await pool?.end();
  });

  it('backfills legacy reports and aggregate counts', async () => {
    const reports = await prisma.analysisReport.findMany({
      where: { userId },
      include: { job: true },
      orderBy: { syncTime: 'asc' },
    });
    const stat = await prisma.userStat.findUniqueOrThrow({
      where: { userId },
    });

    expect(reports).toHaveLength(2);
    expect(reports.every((report) => report.job?.status === 'SUCCEEDED')).toBe(
      true,
    );
    expect(
      reports.every(
        (report) =>
          report.job?.modelVersion === 'legacy' &&
          report.job.promptVersion === 'legacy' &&
          report.job.totalTokens === null,
      ),
    ).toBe(true);
    expect(stat.analysisCount).toBe(2);
  });

  it('allows only reconciliation failures to preserve unknown unsettled usage', async () => {
    const job = await createRunningJob('integration-unknown-usage');

    await analysisJobService.transition({
      jobId: job.id,
      fromStatus: AnalysisJobStatus.RUNNING,
      toStatus: AnalysisJobStatus.FAILED,
      expectedLeaseToken: job.leaseToken,
      expectedUserId: userId,
      expectedRepositoryId: repositoryId,
      expectedReservedTokens: null,
      data: {
        completedAt: settlement.completedAt,
        tokensSettledAt: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        providerRequestIds: ['chatcmpl_integration_unknown'],
        errorCode: AnalysisJobFailureCode.PROVIDER_RECONCILIATION_REQUIRED,
        errorRetryable: false,
      },
    });

    const failed = await prisma.analysisJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(failed).toMatchObject({
      status: AnalysisJobStatus.FAILED,
      tokensSettledAt: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      lastErrorCode: 'PROVIDER_RECONCILIATION_REQUIRED',
    });

    await expect(
      pool.query(
        `INSERT INTO "analysis_jobs" (
           "id", "status", "userId", "repositoryId", "idempotencyKey",
           "requestHash", "lastErrorCode", "completedAt", "updatedAt"
         ) VALUES ($1, 'FAILED', $2, $3, $4, $5, 'ANALYSIS_FAILED', NOW(), NOW())`,
        [
          'invalid-unsettled-failure',
          userId,
          repositoryId,
          'integration-invalid-unsettled',
          'a'.repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ constraint: 'analysis_jobs_failed_check' });
  });

  it('allows only one terminal CAS winner for a leased Job', async () => {
    const job = await createRunningJob('integration-cas');
    const transition = () =>
      analysisJobService.transition({
        jobId: job.id,
        fromStatus: AnalysisJobStatus.RUNNING,
        toStatus: AnalysisJobStatus.FAILED,
        expectedLeaseToken: job.leaseToken,
        expectedUserId: userId,
        expectedRepositoryId: repositoryId,
        expectedReservedTokens: null,
        data: {
          ...settlement,
          errorCode: AnalysisJobFailureCode.ANALYSIS_FAILED,
          errorRetryable: false,
        },
      });

    const results = await Promise.allSettled([transition(), transition()]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(StaleAnalysisJobTransitionError);
  });

  it('rolls back report creation and success CAS together', async () => {
    const job = await createRunningJob('integration-rollback');
    await prisma.analysisJob.update({
      where: { id: job.id },
      data: { estimatedTokens: 5, reservedTokens: 10 },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        const report = await tx.analysisReport.create({
          data: { userId, repositoryId, jobId: job.id },
        });
        await analysisJobService.transition(
          {
            jobId: job.id,
            fromStatus: AnalysisJobStatus.RUNNING,
            toStatus: AnalysisJobStatus.SUCCEEDED,
            expectedLeaseToken: job.leaseToken,
            expectedUserId: userId,
            expectedRepositoryId: repositoryId,
            expectedReservedTokens: 10,
            data: { ...settlement, reportId: report.id },
          },
          tx,
        );
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const [persistedJob, persistedReport] = await Promise.all([
      prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.analysisReport.findUnique({ where: { jobId: job.id } }),
    ]);
    expect(persistedJob.status).toBe(AnalysisJobStatus.RUNNING);
    expect(persistedJob.tokensSettledAt).toBeNull();
    expect(persistedReport).toBeNull();
  });

  it('serializes concurrent creation of the first user aggregate', async () => {
    const user = await prisma.user.create({
      data: {
        githubId: 'concurrent-stat-user',
        username: 'concurrent-stat-user',
      },
    });
    const statService = new StatService();
    const firstMetrics = createMetrics(4);
    const secondMetrics = createMetrics(2);

    await Promise.all([
      prisma.$transaction((tx) =>
        statService.updateStats(user.id, firstMetrics, tx),
      ),
      prisma.$transaction((tx) =>
        statService.updateStats(user.id, secondMetrics, tx),
      ),
    ]);

    const stat = await prisma.userStat.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(stat.analysisCount).toBe(2);
    const distanceFromValidResult = Math.min(
      Math.abs(stat.mutualRespectScore - 2.6),
      Math.abs(stat.mutualRespectScore - 3.4),
    );
    expect(distanceFromValidResult).toBeLessThan(Number.EPSILON * 4);
  });

  it('creates one Job for concurrent requests with the same idempotency key', async () => {
    const repository = await prisma.repository.create({
      data: {
        githubRepoId: 'integration-api-idempotency',
        fullName: 'owner/api-idempotency',
        ownerId: userId,
      },
    });

    const [first, second] = await Promise.all([
      analysisJobApiService.create(
        userId,
        repository.githubRepoId,
        'integration-api-same-key',
      ),
      analysisJobApiService.create(
        userId,
        repository.githubRepoId,
        'integration-api-same-key',
      ),
    ]);

    expect(second.job.jobId).toBe(first.job.jobId);
    await expect(
      prisma.analysisJob.count({
        where: {
          userId,
          idempotencyKey: 'integration-api-same-key',
        },
      }),
    ).resolves.toBe(1);
  });

  it('allows only one active Job for concurrent repository requests with different keys', async () => {
    const repository = await prisma.repository.create({
      data: {
        githubRepoId: 'integration-api-active-job',
        fullName: 'owner/api-active-job',
        ownerId: userId,
      },
    });

    const results = await Promise.allSettled([
      analysisJobApiService.create(
        userId,
        repository.githubRepoId,
        'integration-api-active-key-1',
      ),
      analysisJobApiService.create(
        userId,
        repository.githubRepoId,
        'integration-api-active-key-2',
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const rejectionReason: unknown = rejected?.reason;
    expect(rejectionReason).toBeInstanceOf(HttpException);
    if (!(rejectionReason instanceof HttpException)) {
      throw new Error('Expected an HTTP conflict');
    }
    const rejectionResponse = rejectionReason.getResponse();
    if (typeof rejectionResponse !== 'object' || rejectionResponse === null) {
      throw new Error('Expected a structured API conflict');
    }
    expect((rejectionResponse as Record<string, unknown>).code).toBe(
      'ACTIVE_JOB_EXISTS',
    );
    await expect(
      prisma.analysisJob.count({
        where: {
          repositoryId: repository.id,
          status: {
            in: [AnalysisJobStatus.QUEUED, AnalysisJobStatus.RUNNING],
          },
        },
      }),
    ).resolves.toBe(1);
  });

  it('allows only one active Job across API and synchronous creation paths', async () => {
    const repository = await prisma.repository.create({
      data: {
        githubRepoId: 'integration-cross-path-active-job',
        fullName: 'owner/cross-path-active-job',
        ownerId: userId,
      },
    });

    const results = await Promise.allSettled([
      analysisJobApiService.create(
        userId,
        repository.githubRepoId,
        'integration-cross-path-api',
      ),
      analysisJobService.create({
        userId,
        repositoryId: repository.id,
        idempotencyKey: 'sync:integration-cross-path',
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const rejectionReason: unknown = rejected?.reason;
    const isApiConflict =
      rejectionReason instanceof HttpException &&
      typeof rejectionReason.getResponse() === 'object' &&
      rejectionReason.getResponse() !== null &&
      (rejectionReason.getResponse() as Record<string, unknown>).code ===
        'ACTIVE_JOB_EXISTS';
    expect(
      rejectionReason instanceof ActiveAnalysisJobExistsError || isApiConflict,
    ).toBe(true);
    await expect(
      prisma.analysisJob.count({
        where: {
          repositoryId: repository.id,
          status: {
            in: [AnalysisJobStatus.QUEUED, AnalysisJobStatus.RUNNING],
          },
        },
      }),
    ).resolves.toBe(1);
  });

  it('recovers stale synchronous and expired leased Jobs under the repository lock', async () => {
    const staleQueuedRepository = await prisma.repository.create({
      data: {
        githubRepoId: 'integration-stale-queued-job',
        fullName: 'owner/stale-queued-job',
        ownerId: userId,
      },
    });
    const staleQueued = await prisma.analysisJob.create({
      data: {
        userId,
        repositoryId: staleQueuedRepository.id,
        idempotencyKey: 'sync:stale-queued',
        requestHash: 'a'.repeat(64),
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    });

    await analysisJobService.create({
      userId,
      repositoryId: staleQueuedRepository.id,
      idempotencyKey: 'sync:replacement-queued',
    });

    await expect(
      prisma.analysisJob.findUniqueOrThrow({ where: { id: staleQueued.id } }),
    ).resolves.toMatchObject({
      status: AnalysisJobStatus.FAILED,
      totalTokens: 0,
      lastErrorCode: 'ANALYSIS_FAILED',
      errorRetryable: true,
    });

    const staleRunningRepository = await prisma.repository.create({
      data: {
        githubRepoId: 'integration-stale-running-job',
        fullName: 'owner/stale-running-job',
        ownerId: userId,
      },
    });
    const staleRunning = await prisma.analysisJob.create({
      data: {
        userId,
        repositoryId: staleRunningRepository.id,
        idempotencyKey: 'sync:stale-running',
        requestHash: 'b'.repeat(64),
        status: AnalysisJobStatus.RUNNING,
        stage: 'ANALYZING',
        reservedTokens: 20,
        leaseToken: 'expired-lease',
        leaseExpiresAt: new Date('2026-08-01T00:00:00.000Z'),
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    });

    await analysisJobService.create({
      userId,
      repositoryId: staleRunningRepository.id,
      idempotencyKey: 'sync:replacement-running',
    });

    await expect(
      prisma.analysisJob.findUniqueOrThrow({ where: { id: staleRunning.id } }),
    ).resolves.toMatchObject({
      status: AnalysisJobStatus.FAILED,
      tokensSettledAt: null,
      lastErrorCode: 'PROVIDER_RECONCILIATION_REQUIRED',
      errorRetryable: false,
      leaseToken: null,
    });
  });

  it('allows at most five concurrent API Job creations across Lambda instances', async () => {
    const secondApiService = new AnalysisJobApiService(
      new AnalysisJobApiRepository(prisma as unknown as PrismaService),
      new AnalysisJobResponseMapper(),
      new AnalysisJobRepository(prisma as unknown as PrismaService),
      publisher,
    );
    const apiInstances = [analysisJobApiService, secondApiService];
    const rateLimitedUser = await prisma.user.create({
      data: {
        githubId: 'rate-limited-user',
        username: 'rate-limited-user',
      },
    });
    const repositories = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        prisma.repository.create({
          data: {
            githubRepoId: `integration-rate-limit-${index}`,
            fullName: `owner/rate-limit-${index}`,
            ownerId: rateLimitedUser.id,
          },
        }),
      ),
    );

    const results = await Promise.allSettled(
      repositories.map((repository, index) =>
        apiInstances[index % apiInstances.length].create(
          rateLimitedUser.id,
          repository.githubRepoId,
          `integration-rate-limit-key-${index}`,
        ),
      ),
    );

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(5);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const rejectionReason: unknown = rejected?.reason;
    expect(rejectionReason).toBeInstanceOf(HttpException);
    if (!(rejectionReason instanceof HttpException)) {
      throw new Error('Expected an HTTP rate limit error');
    }
    expect(rejectionReason.getStatus()).toBe(429);
    const rejectionResponse = rejectionReason.getResponse();
    expect(
      typeof rejectionResponse === 'object' && rejectionResponse !== null
        ? (rejectionResponse as Record<string, unknown>).code
        : undefined,
    ).toBe('RATE_LIMITED');
    await expect(
      prisma.analysisJob.count({ where: { userId: rateLimitedUser.id } }),
    ).resolves.toBe(5);
  });

  it('selects only due unpublished or stale-published Jobs', async () => {
    const now = new Date('2026-08-25T05:00:00.000Z');
    const dueUnpublished = await createPublishJob('due-unpublished');
    const future = await createPublishJob('future', {
      nextPublishAt: new Date('2026-08-25T05:01:00.000Z'),
    });
    const recentlyPublished = await createPublishJob('recent-published', {
      messagePublishedAt: new Date('2026-08-25T04:59:30.000Z'),
    });
    const stalePublished = await createPublishJob('stale-published', {
      messagePublishedAt: new Date('2026-08-25T04:58:00.000Z'),
    });
    const synchronous = await createPublishJob('synchronous', {
      idempotencyKey: 'sync:integration-publish-query',
    });

    const due = await analysisJobPublishRepository.findDue(now, 60, 5, 100);
    const dueIds = new Set(due.map((job) => job.id));

    expect(dueIds).toContain(dueUnpublished.id);
    expect(dueIds).toContain(stalePublished.id);
    expect(dueIds).not.toContain(future.id);
    expect(dueIds).not.toContain(recentlyPublished.id);
    expect(dueIds).not.toContain(synchronous.id);
  });

  it('uses publish snapshot CAS so a late failure cannot overwrite success', async () => {
    const job = await createPublishJob('publish-cas');
    const claimedNextPublishAt = new Date('2026-08-25T06:01:00.000Z');
    await expect(
      analysisJobPublishRepository.claimAttempt({
        job,
        claimedNextPublishAt,
        deliveryUncertain: false,
      }),
    ).resolves.toBe(true);
    await expect(
      analysisJobPublishRepository.markPublished(
        { job, attempt: 1, claimedNextPublishAt },
        new Date('2026-08-25T06:00:00.000Z'),
      ),
    ).resolves.toBe(true);
    await expect(
      analysisJobPublishRepository.recordFailure({
        job,
        attempt: 1,
        claimedNextPublishAt,
        nextPublishAt: new Date('2026-08-25T06:02:00.000Z'),
        deliveryUncertain: false,
        terminate: false,
        completedAt: new Date('2026-08-25T06:00:00.000Z'),
      }),
    ).resolves.toBe(false);

    await expect(
      prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      messagePublishedAt: new Date('2026-08-25T06:00:00.000Z'),
      nextPublishAt: null,
      lastErrorCode: null,
    });
  });

  it('allows only one concurrent reconciler to send a due snapshot', async () => {
    await prisma.analysisJob.updateMany({
      where: { status: AnalysisJobStatus.QUEUED },
      data: { nextPublishAt: new Date('2100-01-01T00:00:00.000Z') },
    });
    const job = await createPublishJob('concurrent-reconciler');
    const publish = jest.fn().mockResolvedValue({ messageId: 'message-1' });
    const queue: AnalysisJobQueue = { publish };
    const config = createPublishConfig();
    const publisherService = new AnalysisJobPublisherService(
      analysisJobPublishRepository,
      queue,
      config,
    );
    const first = new AnalysisJobReconcilerService(
      analysisJobPublishRepository,
      publisherService,
      config,
    );
    const second = new AnalysisJobReconcilerService(
      analysisJobPublishRepository,
      publisherService,
      config,
    );
    const now = new Date('2026-08-25T07:00:00.000Z');

    await Promise.all([first.runOnce(now), second.runOnce(now)]);

    expect(publish).toHaveBeenCalledTimes(1);
    await expect(
      prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ publishAttempts: 1 });
  });

  it('settles all failure invariants after the final confirmed publish failure', async () => {
    const job = await createPublishJob('publish-limit', {
      publishAttempts: 4,
      lastErrorCode: 'PUBLISH_ATTEMPT_FAILED',
    });
    const queue: AnalysisJobQueue = {
      publish: jest.fn().mockRejectedValue(new Error('fault injection')),
    };
    const publisherService = new AnalysisJobPublisherService(
      analysisJobPublishRepository,
      queue,
      createPublishConfig(),
    );

    await expect(
      publisherService.publish(job, {
        allowRepublish: false,
        now: new Date('2026-08-25T08:00:00.000Z'),
        traceId: 'postgres-integration',
        random: 0,
      }),
    ).resolves.toBe(AnalysisJobPublishOutcome.FAILED);
    await expect(
      prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: AnalysisJobStatus.FAILED,
      stage: null,
      lastErrorCode: 'PUBLISH_FAILED',
      lastErrorMessage: 'The analysis job could not be published.',
      errorRetryable: true,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokensSettledAt: new Date('2026-08-25T08:00:00.000Z'),
      completedAt: new Date('2026-08-25T08:00:00.000Z'),
    });
  });

  it('keeps lastSyncTime monotonic when an older sync finishes last', async () => {
    const olderSyncStartedAt = new Date('2026-08-21T11:00:00.000Z');
    const newerSyncStartedAt = new Date('2026-08-21T11:05:00.000Z');

    await prisma.repository.updateMany({
      where: {
        id: repositoryId,
        OR: [
          { lastSyncTime: null },
          { lastSyncTime: { lt: newerSyncStartedAt } },
        ],
      },
      data: { lastSyncTime: newerSyncStartedAt },
    });
    await prisma.repository.updateMany({
      where: {
        id: repositoryId,
        OR: [
          { lastSyncTime: null },
          { lastSyncTime: { lt: olderSyncStartedAt } },
        ],
      },
      data: { lastSyncTime: olderSyncStartedAt },
    });

    await expect(
      prisma.repository.findUniqueOrThrow({
        where: { id: repositoryId },
        select: { lastSyncTime: true },
      }),
    ).resolves.toEqual({ lastSyncTime: newerSyncStartedAt });
  });

  async function createRunningJob(idempotencyKey: string) {
    const job = await analysisJobService.create({
      userId,
      repositoryId,
      idempotencyKey: `sync:${idempotencyKey}`,
    });
    const leaseToken = `lease-${idempotencyKey}`;
    await analysisJobService.transition({
      jobId: job.id,
      fromStatus: AnalysisJobStatus.QUEUED,
      toStatus: AnalysisJobStatus.RUNNING,
      data: {
        leaseToken,
        leaseExpiresAt: new Date('2026-08-04T01:00:00.000Z'),
        startedAt: new Date('2026-08-04T00:00:00.000Z'),
      },
    });
    return { id: job.id, leaseToken };
  }

  async function createPublishJob(
    suffix: string,
    overrides: {
      idempotencyKey?: string;
      publishAttempts?: number;
      messagePublishedAt?: Date;
      nextPublishAt?: Date;
      lastErrorCode?: string;
    } = {},
  ): Promise<AnalysisJobPublishRecord> {
    const repository = await prisma.repository.create({
      data: {
        githubRepoId: `integration-publish-${suffix}`,
        fullName: `owner/publish-${suffix}`,
        ownerId: userId,
      },
    });
    return prisma.analysisJob.create({
      data: {
        userId,
        repositoryId: repository.id,
        idempotencyKey:
          overrides.idempotencyKey ?? `integration-publish-${suffix}`,
        requestHash: 'c'.repeat(64),
        publishAttempts: overrides.publishAttempts,
        messagePublishedAt: overrides.messagePublishedAt,
        nextPublishAt: overrides.nextPublishAt,
        lastErrorCode: overrides.lastErrorCode,
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

  function createPublishConfig(): AnalysisJobQueueConfig {
    return new AnalysisJobQueueConfig(
      new ConfigService({
        AWS_REGION: 'us-east-1',
        ANALYSIS_JOB_QUEUE_URL:
          'http://127.0.0.1:4566/000000000000/analysis-jobs.fifo',
        ANALYSIS_JOB_PUBLISH_MAX_ATTEMPTS: '5',
        ANALYSIS_JOB_REPUBLISH_AFTER_SECONDS: '60',
        ANALYSIS_JOB_RECONCILE_BATCH_SIZE: '100',
      }),
    );
  }

  function createMetrics(score: number) {
    return {
      mutualRespectScore: score,
      conflictManagementScore: score,
      logicalProblemScore: score,
      reviewGuidingScore: score,
      documentationScore: score,
      knowledgeSharingScore: score,
      technicalInfluenceScore: score,
      codeStabilityScore: score,
    };
  }
});
