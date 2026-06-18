import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EncryptionService } from '../auth/encryption.service';
import { PrismaService } from '../prisma/prisma.service';
import { GithubAppAuthService } from './github-app-auth.service';
import { GithubAppConfig } from './github-app.config';
import { GithubAppService } from './github-app.service';

describe('GithubAppService', () => {
  const prisma = {
    githubAppInstallState: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    githubInstallation: {
      upsert: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };
  const jwtService = {
    signAsync: jest.fn(),
    verifyAsync: jest.fn(),
  };
  const encryptionService = {
    decrypt: jest.fn(),
  };
  const githubAuth = {
    createAppOctokit: jest.fn(),
    createUserOctokit: jest.fn(),
  };
  const config = {
    installUrl: 'https://github.com/apps/git-mate-v2/installations/new',
    jwtSecret: 'test-jwt-secret',
    frontendUrl: 'http://localhost:3005',
  };

  let service: GithubAppService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GithubAppService(
      prisma as unknown as PrismaService,
      jwtService as unknown as JwtService,
      encryptionService as unknown as EncryptionService,
      githubAuth as unknown as GithubAppAuthService,
      config as GithubAppConfig,
    );
  });

  it('creates an installation URL with a signed state', async () => {
    prisma.githubAppInstallState.create.mockResolvedValue({ id: 'state-id' });
    jwtService.signAsync.mockResolvedValue('signed-state');

    await expect(service.createInstallUrl(7)).resolves.toEqual({
      url: 'https://github.com/apps/git-mate-v2/installations/new?state=signed-state',
    });
    expect(prisma.githubAppInstallState.create).toHaveBeenCalledWith({
      data: {
        userId: 7,
        expiresAt: expect.any(Date) as Date,
      },
    });
  });

  it('reports login and GitHub App installation as separate states', async () => {
    prisma.user.findUnique.mockResolvedValue({
      githubToken: 'encrypted-oauth-token',
      _count: { githubInstallations: 1 },
    });

    await expect(service.getConnectionStatus(7)).resolves.toEqual({
      loggedIn: true,
      githubAppInstalled: true,
      requiresInstallation: false,
      requiresOAuthReauthorization: false,
      activeInstallationCount: 1,
      installUrlEndpoint: '/github-app/installations/install-url',
    });
  });

  it('guides a logged-in user who has not installed the GitHub App', async () => {
    prisma.user.findUnique.mockResolvedValue({
      githubToken: null,
      _count: { githubInstallations: 0 },
    });

    await expect(service.getConnectionStatus(7)).resolves.toEqual({
      loggedIn: true,
      githubAppInstalled: false,
      requiresInstallation: true,
      requiresOAuthReauthorization: true,
      activeInstallationCount: 0,
      installUrlEndpoint: '/github-app/installations/install-url',
    });
  });

  it('rejects a consumed installation state', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      sub: 7,
      jti: 'state-id',
      purpose: 'github-app-install',
    });
    prisma.githubAppInstallState.findUnique.mockResolvedValue({
      id: 'state-id',
      userId: 7,
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user: {},
    });

    await expect(
      service.completeInstallation('123', 'signed-state'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(githubAuth.createAppOctokit).not.toHaveBeenCalled();
  });

  it('rejects a new installation callback without state', async () => {
    await expect(service.completeInstallation('123')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(githubAuth.createAppOctokit).not.toHaveBeenCalled();
  });

  it('syncs a verified installation update without state', async () => {
    const installation = {
      id: 123,
      account: {
        id: 7,
        login: 'chya-chya',
        type: 'User',
      },
      repository_selection: 'selected',
      suspended_at: null,
      created_at: '2026-06-10T08:00:00Z',
      updated_at: '2026-06-11T08:00:00Z',
    };
    githubAuth.createAppOctokit.mockReturnValue({
      rest: {
        apps: {
          getInstallation: jest.fn().mockResolvedValue({ data: installation }),
        },
      },
    });
    prisma.githubInstallation.upsert.mockResolvedValue({});

    await expect(
      service.completeInstallation('123', undefined, 'update'),
    ).resolves.toBe(
      'http://localhost:3005/repositories?status=updated&installation_id=123',
    );
    expect(prisma.githubInstallation.upsert).toHaveBeenCalledWith({
      where: { githubInstallationId: '123' },
      update: expect.objectContaining({
        accountLogin: 'chya-chya',
        repositorySelection: 'selected',
      }) as object,
      create: expect.objectContaining({
        githubInstallationId: '123',
        accountLogin: 'chya-chya',
        repositorySelection: 'selected',
      }) as object,
    });
  });
});
