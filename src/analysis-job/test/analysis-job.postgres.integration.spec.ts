import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { AnalysisJobStatus, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { StatService } from '../../analysis/stat.service';
import { AnalysisJobRepository } from '../analysis-job.repository';
import {
  AnalysisJobFailureCode,
  AnalysisJobService,
  StaleAnalysisJobTransitionError,
} from '../analysis-job.service';

const runDatabaseIntegrationTests =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === 'true';
const describeDatabase = runDatabaseIntegrationTests ? describe : describe.skip;

describeDatabase('AnalysisJob PostgreSQL invariants', () => {
  let pool: Pool;
  let prismaPool: Pool;
  let prisma: PrismaClient;
  let analysisJobService: AnalysisJobService;
  let userId: number;
  let repositoryId: number;

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
    analysisJobService = new AnalysisJobService(
      new AnalysisJobRepository(prisma),
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

  async function createRunningJob(idempotencyKey: string) {
    const job = await analysisJobService.create({
      userId,
      repositoryId,
      idempotencyKey,
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
