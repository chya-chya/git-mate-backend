import { AnalysisJobStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AnalysisJobPublishRecord,
  AnalysisJobPublishRepository,
} from '../analysis-job-publish.repository';

const NOW = new Date('2026-08-25T00:00:00.000Z');

function createJob(
  overrides: Partial<AnalysisJobPublishRecord> = {},
): AnalysisJobPublishRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: AnalysisJobStatus.QUEUED,
    userId: 7,
    repositoryId: 17,
    idempotencyKey: 'api-request-1',
    reservedTokens: null,
    publishAttempts: 0,
    messagePublishedAt: null,
    nextPublishAt: null,
    lastErrorCode: null,
    createdAt: new Date('2026-08-24T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AnalysisJobPublishRepository', () => {
  const prisma = {
    analysisJob: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const repository = new AnalysisJobPublishRepository(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.analysisJob.findMany.mockResolvedValue([]);
    prisma.analysisJob.updateMany.mockResolvedValue({ count: 1 });
  });

  it('selects only due queued API Jobs in oldest-first batches', async () => {
    await repository.findDue(NOW, 60, 5, 20);

    expect(prisma.analysisJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: AnalysisJobStatus.QUEUED,
          idempotencyKey: { not: { startsWith: 'sync:' } },
          publishAttempts: { lt: 5 },
          AND: [
            {
              OR: [{ nextPublishAt: null }, { nextPublishAt: { lte: NOW } }],
            },
            {
              OR: [
                { messagePublishedAt: null },
                {
                  messagePublishedAt: {
                    lte: new Date('2026-08-24T23:59:00.000Z'),
                  },
                },
              ],
            },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 20,
      }),
    );
  });

  it('claims against all observed publish fields', async () => {
    const job = createJob({
      publishAttempts: 2,
      messagePublishedAt: new Date('2026-08-24T23:00:00.000Z'),
      nextPublishAt: new Date('2026-08-24T23:30:00.000Z'),
    });
    const claimedNextPublishAt = new Date('2026-08-25T00:01:00.000Z');

    await repository.claimAttempt({
      job,
      claimedNextPublishAt,
      deliveryUncertain: true,
    });

    expect(prisma.analysisJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: job.id,
        status: AnalysisJobStatus.QUEUED,
        publishAttempts: 2,
        messagePublishedAt: job.messagePublishedAt,
        nextPublishAt: job.nextPublishAt,
      },
      data: {
        publishAttempts: { increment: 1 },
        nextPublishAt: claimedNextPublishAt,
        lastErrorCode: 'PUBLISH_DELIVERY_UNCERTAIN',
        lastErrorMessage: null,
        errorRetryable: null,
      },
    });
  });

  it('prevents a late failure from overwriting a newer success', async () => {
    const job = createJob();
    const claimedNextPublishAt = new Date('2026-08-25T00:01:00.000Z');
    prisma.analysisJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      repository.markPublished({ job, attempt: 2, claimedNextPublishAt }, NOW),
    ).resolves.toBe(true);
    await expect(
      repository.recordFailure({
        job,
        attempt: 1,
        claimedNextPublishAt,
        nextPublishAt: new Date('2026-08-25T00:02:00.000Z'),
        deliveryUncertain: false,
        terminate: false,
        completedAt: NOW,
      }),
    ).resolves.toBe(false);
  });

  it('writes all existing FAILED invariants after the final confirmed failure', async () => {
    const job = createJob({ publishAttempts: 4 });
    const claimedNextPublishAt = new Date('2026-08-25T00:01:00.000Z');

    await repository.recordFailure({
      job,
      attempt: 5,
      claimedNextPublishAt,
      nextPublishAt: new Date('2026-08-25T00:10:00.000Z'),
      deliveryUncertain: false,
      terminate: true,
      completedAt: NOW,
    });

    expect(prisma.analysisJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: job.id,
        status: AnalysisJobStatus.QUEUED,
        publishAttempts: 5,
        messagePublishedAt: null,
        nextPublishAt: claimedNextPublishAt,
        reservedTokens: null,
      },
      data: {
        status: AnalysisJobStatus.FAILED,
        stage: null,
        nextPublishAt: null,
        lastErrorCode: 'PUBLISH_FAILED',
        lastErrorMessage: 'The analysis job could not be published.',
        errorRetryable: true,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        tokensSettledAt: NOW,
        completedAt: NOW,
      },
    });
  });
});
