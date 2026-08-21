import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Octokit } from '@octokit/rest';
import { ActiveAnalysisJobExistsError } from '../../analysis-job/analysis-job.repository';
import { AnalysisService } from '../../analysis/analysis.service';
import { GithubAppService } from '../../github-app/github-app.service';
import { GithubInstallationTokenService } from '../../github-app/github-installation-token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CollectionService } from '../collection.service';
import { GithubProvider } from '../github.provider';

describe('CollectionService', () => {
  let service: CollectionService;
  const githubProvider = {
    fetchPullRequests: jest.fn(),
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

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionService,
        { provide: GithubProvider, useValue: githubProvider },
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

  it('fetches pull requests through an installation token', async () => {
    const repository = {
      id: 1,
      githubRepoId: '11',
      fullName: 'owner/private-repo',
      lastSyncTime: new Date('2026-01-01T00:00:00Z'),
      ownerId: 7,
      owner: { username: 'developer' },
    };
    prisma.repository.findUnique.mockResolvedValue(repository);
    githubProvider.fetchPullRequests.mockResolvedValue({
      repository: { pullRequests: { nodes: [] } },
    });
    installationTokens.executeForRepository.mockImplementation(
      async (
        _userId: number,
        _githubRepoId: string,
        operation: (octokit: Octokit) => Promise<unknown>,
      ) => operation({} as Octokit),
    );
    prisma.repository.updateMany.mockResolvedValue({ count: 1 });
    analysisService.runAnalysis.mockResolvedValue({});

    await service.syncRepository('11', 7);

    expect(installationTokens.executeForRepository).toHaveBeenCalledWith(
      7,
      '11',
      expect.any(Function),
    );
    expect(githubProvider.fetchPullRequests).toHaveBeenCalledWith(
      'owner',
      'private-repo',
      expect.anything(),
      repository.lastSyncTime,
    );
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
    const githubData = {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 42,
              title: 'Keep the API contract',
              body: 'PR body',
              author: { login: 'reviewer' },
              updatedAt: '2026-06-12T00:00:00Z',
              permalink: 'https://github.com/owner/private-repo/pull/42',
              reviews: {
                nodes: [
                  {
                    author: { login: 'maintainer' },
                    body: 'Looks good',
                    state: 'APPROVED',
                    comments: {
                      nodes: [
                        {
                          author: { login: 'maintainer' },
                          body: 'Nice change',
                          createdAt: '2026-06-12T00:01:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
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
    installationTokens.executeForRepository.mockImplementation(
      async (
        _userId: number,
        _githubRepoId: string,
        operation: (octokit: Octokit) => Promise<unknown>,
      ) => {
        jest.setSystemTime(new Date('2026-06-12T12:05:00Z'));
        return operation({} as Octokit);
      },
    );
    githubProvider.fetchPullRequests.mockResolvedValue(githubData);
    prisma.repository.updateMany.mockResolvedValue({ count: 1 });
    analysisService.runAnalysis.mockResolvedValue({});

    await expect(service.syncRepository('11', 7)).resolves.toEqual(
      expectedResponse,
    );
    expect(analysisService.runAnalysis).toHaveBeenCalledWith(
      7,
      1,
      expectedResponse,
    );
    expect(prisma.repository.updateMany).toHaveBeenCalledWith({
      where: {
        githubRepoId: '11',
        OR: [{ lastSyncTime: null }, { lastSyncTime: { lt: syncStartedAt } }],
      },
      data: { lastSyncTime: syncStartedAt },
    });
    expect(
      analysisService.runAnalysis.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.repository.updateMany.mock.invocationCallOrder[0]);
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
    installationTokens.executeForRepository.mockImplementation(
      async (
        _userId: number,
        _githubRepoId: string,
        operation: (octokit: Octokit) => Promise<unknown>,
      ) => operation({} as Octokit),
    );
    githubProvider.fetchPullRequests.mockResolvedValue({
      repository: { pullRequests: { nodes: [] } },
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
    installationTokens.executeForRepository.mockImplementation(
      async (
        _userId: number,
        _githubRepoId: string,
        operation: (octokit: Octokit) => Promise<unknown>,
      ) => operation({} as Octokit),
    );
    githubProvider.fetchPullRequests.mockResolvedValue({
      repository: { pullRequests: { nodes: [] } },
    });
    analysisService.runAnalysis.mockResolvedValue({});
    prisma.repository.updateMany.mockResolvedValue({ count: 0 });

    await service.syncRepository('11', 7);

    expect(prisma.repository.updateMany).toHaveBeenCalledWith({
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
    installationTokens.executeForRepository.mockRejectedValue(
      new ForbiddenException('Repository is not accessible'),
    );

    await expect(service.syncRepository('11', 7)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(githubProvider.fetchPullRequests).not.toHaveBeenCalled();
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
