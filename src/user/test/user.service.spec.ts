import { NotFoundException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UserService } from '../user.service';

describe('UserService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  let service: UserService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UserService(prisma as unknown as PrismaService);
  });

  it('deactivates the current user and clears the refresh token', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7 });
    prisma.user.update.mockResolvedValue({
      status: UserStatus.DEACTIVATED,
    });

    await expect(service.deactivateUser(7)).resolves.toEqual({
      success: true,
      status: UserStatus.DEACTIVATED,
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { id: true },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        status: UserStatus.DEACTIVATED,
        hashedRefreshToken: null,
      },
      select: { status: true },
    });
  });

  it('throws when the current user no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.deactivateUser(7)).rejects.toThrow(NotFoundException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
