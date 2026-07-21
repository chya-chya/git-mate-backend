import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { JwtStrategy } from '../../strategies/jwt.strategy';

describe('JwtStrategy', () => {
  const configService = {
    get: jest.fn(),
  };
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
  };

  let strategy: JwtStrategy;

  beforeEach(() => {
    jest.clearAllMocks();
    configService.get.mockReturnValue('jwt-secret');
    strategy = new JwtStrategy(
      configService as unknown as ConfigService,
      prisma as unknown as PrismaService,
    );
  });

  it('returns the active user from the database', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      username: 'chya-chya',
      status: UserStatus.ACTIVE,
    });

    await expect(
      strategy.validate({ sub: 7, username: 'token-username' }),
    ).resolves.toEqual({
      id: 7,
      username: 'chya-chya',
    });
  });

  it('blocks deactivated users with a product-specific 403 code', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      username: 'chya-chya',
      status: UserStatus.DEACTIVATED,
    });

    await expect(
      strategy.validate({ sub: 7, username: 'chya-chya' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects tokens for users that no longer exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      strategy.validate({ sub: 7, username: 'chya-chya' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
