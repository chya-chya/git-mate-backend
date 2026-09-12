import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ActiveAnalysisJobExistsError } from '../../analysis-job/analysis-job.repository';
import { AnalysisService } from '../../analysis/analysis.service';
import { GithubAppService } from '../../github-app/github-app.service';
import { GithubInstallationTokenService } from '../../github-app/github-installation-token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CollectionService } from '../collection.service';
import { RepositoryCollectionService } from '../repository-collection.service';

describe('CollectionService', () => {
  let service: CollectionService;
  const repositoryCollection = {
    collect: jest.fn(),
  };
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
    repository: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const transaction = {
    repository: {
      updateMany: jest.fn(),
    },
  };
  const analysisService = {
    runAnalysis: jest.fn(),
    estimateTokens: jest.fn(),
  };
  const installationTokens = {
    executeForRepository: jest.fn(),
    getAvailableRepos: jest.fn(),
  };
  const githubAppService = {
    getInstallations: jest.fn(),
  };

  const mockSuccessfulAnalysis = () => {
    analysisService.runAnalysis.mockImplementation(
      async (
        _userId: number,
        _repositoryId: number,
        _data: unknown,
        completionAction?: (tx: unknown) => Promise<unknown>,
      ) => completionAction?.(transaction),
    );
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionService,
        {
          provide: RepositoryCollectionService,
          useValue: repositoryCollection,
        },
        { provide: PrismaService, useValue: prisma },
        { provide: AnalysisService, useValue: analysisService },
        { provide: GithubAppService, useValue: githubAppService },
        {
          provide: GithubInstallationTokenService,
          useValue: installationTokens,
        },
      ],
    }).compile();

    service = module.get(CollectionService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the repository cursor when collecting pull requests', async () => {
    const repository = {
      id: 1,
      githubRepoId: '11',
      fullName: 'owner/private-repo',
      lastSyncTime: new Date('2026-01-01T00:00:00Z'),
      ownerId: 7,
      owner: { username: 'developer' },
    };
    prisma.repository.findUnique.mockResolvedValue(repository);
    repositoryCollection.collect.mockResolvedValue({
      githubRepoId: '11',
      owner: 'owner',
      repo: 'private-repo',
      targetUser: 'developer',
      pullRequests: [],
    });
    transaction.repository.updateMany.mockResolvedValue({ count: 1 });
    mockSuccessfulAnalysis();

    await service.syncRepository('11', 7);

    expect(repositoryCollection.collect).toHaveBeenCalledWith({
      userId: 7,
      githubRepoId: '11',
      fullName: 'owner/private-repo',
      targetUser: 'developer',
      sourceCursor: repository.lastSyncTime,
    });
  });

  it('preserves the existing sync response and analysis input contract', async () => {
    const syncStartedAt = new Date('2026-06-12T12:00:00Z');
    jest.useFakeTimers({ now: syncStartedAt });
    const repository = {
      id: 1,
      githubRepoId: '11',
      fullName: 'owner/private-repo',
      lastSyncTime: null,
      ownerId: 7,
      owner: { username: 'developer' },
    };
    const expectedResponse = {
      githubRepoId: '11',
      owner: 'owner',
      repo: 'private-repo',
      targetUser: 'developer',
      pullRequests: [
        {
          number: 42,
          title: 'Keep the API contract',
          body: 'PR body',
          author: 'reviewer',
          updatedAt: '2026-06-12T00:00:00Z',
          permalink: 'https://github.com/owner/private-repo/pull/42',
          reviews: [
            {
              author: 'maintainer',
              body: 'Looks good',
              state: 'APPROVED',
              comments: [
                {
                  author: 'maintainer',
                  body: 'Nice change',
                  createdAt: '2026-06-12T00:01:00Z',
                },
              ],
            },
          ],
        },
      ],
    };
    prisma.repository.findUnique.mockResolvedValue(repository);
    repositoryCollection.collect.mockImplementation(() => {
      jest.setSystemTime(new Date('2026-06-12T12:05:00Z'));
      return Promise.resolve(expectedResponse);
    });
    transaction.repository.updateMany.mockResolvedValue({ count: 1 });
    mockSuccessfulAnalysis();

    await expect(service.syncRepository('11', 7)).resolves.toEqual(
      expectedResponse,
    );
    expect(analysisService.runAnalysis).toHaveBeenCalledWith(
      7,
      1,
      expectedResponse,
      expect.any(Function),
    );
    expect(transaction.repository.updateMany).toHaveBeenCalledWith({
      where: {
        githubRepoId: '11',
        OR: [{ lastSyncTime: null }, { lastSyncTime: { lt: syncStartedAt } }],
      },
      data: { lastSyncTime: syncStartedAt },
    });
    expect(prisma.repository.updateMany).not.toHaveBeenCalled();
    expect(
      analysisService.runAnalysis.mock.invocationCallOrder[0],
    ).toBeLessThan(
      transaction.repository.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('returns a structured conflict without advancing the sync cursor', async () => {
    prisma.repository.findUnique.mockResolvedValue({
      id: 1,
      githubRepoId: '11',
      fullName: 'owner/private-repo',
      lastSyncTime: null,
      ownerId: 7,
      owner: { username: 'developer' },
    });
    repositoryCollection.collect.mockResolvedValue({
      githubRepoId: '11',
      owner: 'owner',
      repo: 'private-repo',
      targetUser: 'developer',
      pullRequests: [],
    });
    analysisService.runAnalysis.mockRejectedValue(
      new ActiveAnalysisJobExistsError(1),
    );

    const error: unknown = await service
      .syncRepository('11', 7)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'ACTIVE_JOB_EXISTS',
      message: 'An active analysis job already exists for this repository.',
    });
    expect(transaction.repository.updateMany).not.toHaveBeenCalled();
    expect(prisma.repository.updateMany).not.toHaveBeenCalled();
  });

  it('does not move the sync cursor backward when an older sync finishes last', async () => {
    const olderSyncStartedAt = new Date('2026-06-12T12:00:00Z');
    jest.useFakeTimers({ now: olderSyncStartedAt });
    prisma.repository.findUnique.mockResolvedValue({
      id: 1,
      githubRepoId: '11',
      fullName: 'owner/private-repo',
      lastSyncTime: new Date('2026-06-12T11:00:00Z'),
      ownerId: 7,
      owner: { username: 'developer' },
    });
    repositoryCollection.collect.mockResolvedValue({
      githubRepoId: '11',
      owner: 'owner',
      repo: 'private-repo',
      targetUser: 'developer',
      pullRequests: [],
    });
    mockSuccessfulAnalysis();
    transaction.repository.updateMany.mockResolvedValue({ count: 0 });

    await service.syncRepository('11', 7);

    expect(transaction.repository.updateMany).toHaveBeenCalledWith({
      where: {
        githubRepoId: '11',
        OR: [
          { lastSyncTime: null },
          { lastSyncTime: { lt: olderSyncStartedAt } },
        ],
      },
      data: { lastSyncTime: olderSyncStartedAt },
    });
  });

  it('propagates a denied installation repository access check', async () => {
    prisma.repository.findUnique.mockResolvedValue({
      id: 1,
      githubRepoId: '11',
      fullName: 'owner/private-repo',
      lastSyncTime: null,
      ownerId: 7,
      owner: { username: 'developer' },
    });
    repositoryCollection.collect.mockRejectedValue(
      new ForbiddenException('Repository is not accessible'),
    );

    await expect(service.syncRepository('11', 7)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(analysisService.runAnalysis).not.toHaveBeenCalled();
  });

  it('returns only repositories exposed by installations', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7 });
    githubAppService.getInstallations.mockResolvedValue([]);
    installationTokens.getAvailableRepos.mockResolvedValue([
      {
        id: 11,
        fullName: 'owner/private-repo',
        private: true,
        installationId: '101',
      },
    ]);
    prisma.repository.upsert.mockResolvedValue({});
    prisma.repository.findMany.mockResolvedValue([
      {
        id: 1,
        githubRepoId: '11',
        fullName: 'owner/private-repo',
        ownerId: 7,
      },
    ]);

    await service.getRepositories(7);

    expect(githubAppService.getInstallations).toHaveBeenCalledWith(7);
    expect(installationTokens.getAvailableRepos).toHaveBeenCalledWith(7);
    expect(prisma.repository.findMany).toHaveBeenCalledWith({
      where: {
        ownerId: 7,
        githubRepoId: { in: ['11'] },
      },
      orderBy: { fullName: 'asc' },
    });
  });
});
