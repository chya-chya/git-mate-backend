import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '.././encryption.service';
import { AuthService } from '.././auth.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('AuthService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
  };
  const encryptionService = {
    encrypt: jest.fn(),
  };
  const jwtService = {
    signAsync: jest.fn(),
    verifyAsync: jest.fn(),
  };
  const configService = {
    get: jest.fn(),
  };

  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthService(
      prisma as unknown as PrismaService,
      encryptionService as unknown as EncryptionService,
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
    );
  });

  it('keeps OAuth login focused on user identity and stores the reduced-scope token', async () => {
    encryptionService.encrypt.mockReturnValue('encrypted-oauth-token');
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.upsert.mockResolvedValue({
      id: 7,
      githubId: '159997395',
      username: 'chya-chya',
      avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
      githubToken: 'encrypted-oauth-token',
    });

    await expect(
      service.validateUser({
        githubId: '159997395',
        username: 'chya-chya',
        avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
        accessToken: 'reduced-scope-oauth-token',
      }),
    ).resolves.toMatchObject({
      id: 7,
      githubId: '159997395',
      username: 'chya-chya',
    });

    expect(encryptionService.encrypt).toHaveBeenCalledWith(
      'reduced-scope-oauth-token',
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { githubId: '159997395' },
      select: { id: true, status: true },
    });
    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { githubId: '159997395' },
      update: {
        username: 'chya-chya',
        avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
        githubToken: 'encrypted-oauth-token',
      },
      create: {
        githubId: '159997395',
        username: 'chya-chya',
        avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
        githubToken: 'encrypted-oauth-token',
      },
    });
  });

  it('does not restore a deactivated user during normal OAuth login', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      status: UserStatus.DEACTIVATED,
    });

    await expect(
      service.validateUser({
        githubId: '159997395',
        username: 'chya-chya',
        avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
        accessToken: 'reduced-scope-oauth-token',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(encryptionService.encrypt).not.toHaveBeenCalled();
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('refreshes stored GitHub OAuth token data during reauthorization', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      sub: 7,
      purpose: 'github-oauth-reauthorize',
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      githubId: '159997395',
      status: UserStatus.ACTIVE,
    });
    encryptionService.encrypt.mockReturnValue('encrypted-updated-token');
    prisma.user.update.mockResolvedValue({
      id: 7,
      githubId: '159997395',
      username: 'chya-chya',
      avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
      githubToken: 'encrypted-updated-token',
      status: UserStatus.ACTIVE,
    });

    await expect(
      service.completeGithubOAuth(
        {
          githubId: '159997395',
          username: 'chya-chya',
          avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
          accessToken: 'updated-oauth-token',
        },
        'signed-state',
      ),
    ).resolves.toMatchObject({
      id: 7,
      githubId: '159997395',
      username: 'chya-chya',
    });

    expect(jwtService.verifyAsync).toHaveBeenCalledWith('signed-state');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        username: 'chya-chya',
        avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
        githubToken: 'encrypted-updated-token',
      },
    });
  });

  it('rejects reauthorization when the GitHub account does not match', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      sub: 7,
      purpose: 'github-oauth-reauthorize',
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      githubId: '159997395',
      status: UserStatus.ACTIVE,
    });

    await expect(
      service.completeGithubOAuth(
        {
          githubId: '999999999',
          username: 'other-user',
          avatarUrl: 'https://avatars.githubusercontent.com/u/999999999',
          accessToken: 'other-oauth-token',
        },
        'signed-state',
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects invalid GitHub OAuth reauthorization state', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('invalid signature'));

    await expect(
      service.completeGithubOAuth(
        {
          githubId: '159997395',
          username: 'chya-chya',
          avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
          accessToken: 'updated-oauth-token',
        },
        'invalid-state',
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('creates a GitHub reauthorization URL with signed state but without exposing access tokens', async () => {
    configService.get.mockImplementation((key: string) => {
      const values: Record<string, string> = {
        GITHUB_CLIENT_ID: 'github-client-id',
        GITHUB_CALLBACK_URL: 'https://api.example.com/auth/github/callback',
      };

      return values[key];
    });
    jwtService.signAsync.mockResolvedValue('signed-state');

    const result = await service.createGithubReauthorizationUrl(7);
    const url = new URL(result.url);

    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('github-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/auth/github/callback',
    );
    expect(url.searchParams.get('scope')).toBe('read:user read:org');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(result.url).not.toContain('access-token');
    expect(jwtService.signAsync).toHaveBeenCalledWith(
      {
        sub: 7,
        purpose: 'github-oauth-reauthorize',
      },
      {
        expiresIn: '10m',
      },
    );
  });

  it('preserves the existing access and refresh token response shape', async () => {
    jwtService.signAsync
      .mockResolvedValueOnce('access-token')
      .mockResolvedValueOnce('refresh-token');

    await expect(service.getTokens(7, 'chya-chya')).resolves.toEqual({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });
    expect(jwtService.signAsync).toHaveBeenNthCalledWith(
      1,
      { sub: 7, username: 'chya-chya' },
      { expiresIn: '15m' },
    );
    expect(jwtService.signAsync).toHaveBeenNthCalledWith(
      2,
      { sub: 7, username: 'chya-chya' },
      { expiresIn: '7d' },
    );
  });
});
