import { AnalysisJobStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalysisJobApiRepository } from '../analysis-job-api.repository';

describe('AnalysisJobApiRepository ownership queries', () => {
  const prisma = {
    $queryRaw: jest.fn(),
    repository: { findFirst: jest.fn() },
    analysisJob: { findFirst: jest.fn(), findMany: jest.fn() },
  };
  const repository = new AnalysisJobApiRepository(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('derives a shared rolling-window creation limit from API Job rows', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { totalHits: 5, retryAfterSeconds: 15 },
    ]);

    await expect(
      repository.getCreationRateLimitStatus(7, prisma as never),
    ).resolves.toEqual({
      totalHits: 5,
      remaining: 0,
      retryAfterSeconds: 15,
      isBlocked: true,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('includes ownerId in repository lookup', async () => {
    prisma.repository.findFirst.mockResolvedValue(null);

    await repository.findOwnedRepositoryByGithubId(
      7,
      '123456789',
      prisma as never,
    );

    expect(prisma.repository.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { githubRepoId: '123456789', ownerId: 7 },
      }),
    );
  });

  it('includes userId in single Job lookup', async () => {
    prisma.analysisJob.findFirst.mockResolvedValue(null);

    await repository.findOwnedById(7, '11111111-1111-4111-8111-111111111111');

    expect(prisma.analysisJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: '11111111-1111-4111-8111-111111111111',
          userId: 7,
        },
      }),
    );
  });

  it('keeps list filters inside a user-scoped stable cursor query', async () => {
    prisma.analysisJob.findMany.mockResolvedValue([]);
    const createdAt = new Date('2026-08-16T00:00:00.000Z');

    await repository.listOwned({
      userId: 7,
      repositoryId: 17,
      status: AnalysisJobStatus.RUNNING,
      limit: 20,
      cursor: {
        createdAt,
        id: '11111111-1111-4111-8111-111111111111',
      },
    });

    expect(prisma.analysisJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 7,
          repositoryId: 17,
          status: AnalysisJobStatus.RUNNING,
          OR: [
            { createdAt: { lt: createdAt } },
            {
              createdAt,
              id: { lt: '11111111-1111-4111-8111-111111111111' },
            },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
  });
});
