import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GithubAppAuthService } from '../github-app-auth.service';
import { GithubInstallationTokenService } from '../github-installation-token.service';

const mockListReposAccessibleToInstallation = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: {
      apps: {
        listReposAccessibleToInstallation:
          mockListReposAccessibleToInstallation,
      },
    },
  })),
}));

describe('GithubInstallationTokenService', () => {
  const prisma = {
    userGithubInstallation: {
      findMany: jest.fn(),
    },
    githubInstallation: {
      findFirst: jest.fn(),
    },
  };
  const createInstallationAccessToken = jest.fn();
  const githubAppAuth = {
    createAppOctokit: jest.fn().mockReturnValue({
      rest: {
        apps: {
          createInstallationAccessToken,
        },
      },
    }),
  };

  let service: GithubInstallationTokenService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GithubInstallationTokenService(
      prisma as unknown as PrismaService,
      githubAppAuth as unknown as GithubAppAuthService,
    );
  });

  it('returns an actionable error when no GitHub App is installed', async () => {
    prisma.userGithubInstallation.findMany.mockResolvedValue([]);

    await expect(service.getAvailableRepos(7)).rejects.toMatchObject({
      response: {
        code: 'GITHUB_APP_INSTALLATION_REQUIRED',
        message: 'Install or reconnect the GitHub App to access repositories',
        installUrlEndpoint: '/github-app/installations/install-url',
      },
    });
  });

  it('lists only repositories exposed by active linked installations', async () => {
    prisma.userGithubInstallation.findMany.mockResolvedValue([
      { installation: { githubInstallationId: '101' } },
    ]);
    prisma.githubInstallation.findFirst.mockResolvedValue({ id: 1 });
    createInstallationAccessToken.mockResolvedValue({
      data: {
        token: 'installation-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    mockListReposAccessibleToInstallation.mockResolvedValue({
      data: {
        repositories: [
          {
            id: 11,
            full_name: 'owner/private-repo',
            private: true,
          },
        ],
      },
    });

    await expect(service.getAvailableRepos(7)).resolves.toEqual([
      {
        id: 11,
        fullName: 'owner/private-repo',
        private: true,
        installationId: '101',
      },
    ]);
    expect(prisma.userGithubInstallation.findMany).toHaveBeenCalledWith({
      where: {
        userId: 7,
        installation: { status: 'ACTIVE' },
      },
      select: {
        installation: {
          select: { githubInstallationId: true },
        },
      },
    });
  });

  it('reuses a valid cached installation token', async () => {
    prisma.userGithubInstallation.findMany.mockResolvedValue([
      { installation: { githubInstallationId: '101' } },
    ]);
    prisma.githubInstallation.findFirst.mockResolvedValue({ id: 1 });
    createInstallationAccessToken.mockResolvedValue({
      data: {
        token: 'installation-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    mockListReposAccessibleToInstallation.mockResolvedValue({
      data: { repositories: [] },
    });

    await service.getAvailableRepos(7);
    await service.getAvailableRepos(7);

    expect(createInstallationAccessToken).toHaveBeenCalledTimes(1);
  });

  it('refreshes a cached token that is close to expiration', async () => {
    prisma.userGithubInstallation.findMany.mockResolvedValue([
      { installation: { githubInstallationId: '101' } },
    ]);
    prisma.githubInstallation.findFirst.mockResolvedValue({ id: 1 });
    createInstallationAccessToken
      .mockResolvedValueOnce({
        data: {
          token: 'expiring-token',
          expires_at: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
        },
      })
      .mockResolvedValueOnce({
        data: {
          token: 'refreshed-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      });
    mockListReposAccessibleToInstallation.mockResolvedValue({
      data: { repositories: [] },
    });

    await service.getAvailableRepos(7);
    await service.getAvailableRepos(7);

    expect(createInstallationAccessToken).toHaveBeenCalledTimes(2);
  });

  it('blocks repositories outside the installation selection', async () => {
    prisma.userGithubInstallation.findMany.mockResolvedValue([
      { installation: { githubInstallationId: '101' } },
    ]);
    prisma.githubInstallation.findFirst.mockResolvedValue({ id: 1 });
    createInstallationAccessToken.mockResolvedValue({
      data: {
        token: 'installation-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    mockListReposAccessibleToInstallation.mockResolvedValue({
      data: { repositories: [] },
    });

    await expect(
      service.executeForRepository(7, '999', jest.fn()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects token issuance for a non-active installation', async () => {
    prisma.userGithubInstallation.findMany.mockResolvedValue([
      { installation: { githubInstallationId: '101' } },
    ]);
    prisma.githubInstallation.findFirst.mockResolvedValue(null);

    await expect(service.getAvailableRepos(7)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(createInstallationAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes the token once when GitHub rejects it with 401', async () => {
    prisma.userGithubInstallation.findMany.mockResolvedValue([
      { installation: { githubInstallationId: '101' } },
    ]);
    prisma.githubInstallation.findFirst.mockResolvedValue({ id: 1 });
    createInstallationAccessToken
      .mockResolvedValueOnce({
        data: {
          token: 'expired-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      })
      .mockResolvedValueOnce({
        data: {
          token: 'refreshed-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      });
    mockListReposAccessibleToInstallation.mockResolvedValue({
      data: {
        repositories: [
          {
            id: 11,
            full_name: 'owner/private-repo',
            private: true,
          },
        ],
      },
    });
    const operation = jest
      .fn()
      .mockRejectedValueOnce({ status: 401 })
      .mockResolvedValueOnce('success');

    await expect(
      service.executeForRepository(7, '11', operation),
    ).resolves.toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(createInstallationAccessToken).toHaveBeenCalledTimes(2);
  });

  it('refreshes the token when repository listing returns 401', async () => {
    prisma.userGithubInstallation.findMany.mockResolvedValue([
      { installation: { githubInstallationId: '101' } },
    ]);
    prisma.githubInstallation.findFirst.mockResolvedValue({ id: 1 });
    createInstallationAccessToken
      .mockResolvedValueOnce({
        data: {
          token: 'expired-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      })
      .mockResolvedValueOnce({
        data: {
          token: 'refreshed-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      });
    mockListReposAccessibleToInstallation
      .mockRejectedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ data: { repositories: [] } });

    await expect(service.getAvailableRepos(7)).resolves.toEqual([]);
    expect(mockListReposAccessibleToInstallation).toHaveBeenCalledTimes(2);
    expect(createInstallationAccessToken).toHaveBeenCalledTimes(2);
  });
});
