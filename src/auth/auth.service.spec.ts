import { JwtService } from '@nestjs/jwt';
import { EncryptionService } from './encryption.service';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthService', () => {
  const prisma = {
    user: {
      upsert: jest.fn(),
      update: jest.fn(),
    },
  };
  const encryptionService = {
    encrypt: jest.fn(),
  };
  const jwtService = {
    signAsync: jest.fn(),
  };

  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthService(
      prisma as unknown as PrismaService,
      encryptionService as unknown as EncryptionService,
      jwtService as unknown as JwtService,
    );
  });

  it('keeps OAuth login focused on user identity and stores the reduced-scope token', async () => {
    encryptionService.encrypt.mockReturnValue('encrypted-oauth-token');
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
