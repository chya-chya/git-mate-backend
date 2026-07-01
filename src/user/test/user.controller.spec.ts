import type { Request } from 'express';
import { UserStatus } from '@prisma/client';
import { UserController } from '.././user.controller';
import { UserService } from '.././user.service';

describe('UserController', () => {
  const userService = {
    deactivateUser: jest.fn(),
  };

  let controller: UserController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new UserController(userService as unknown as UserService);
  });

  it('deactivates only the authenticated user from the JWT payload', async () => {
    userService.deactivateUser.mockResolvedValue({
      success: true,
      status: UserStatus.DEACTIVATED,
    });

    await expect(
      controller.deactivate({
        user: { id: 7, username: 'chya-chya' },
        body: { userId: 999 },
      } as unknown as Request),
    ).resolves.toEqual({
      success: true,
      status: UserStatus.DEACTIVATED,
    });

    expect(userService.deactivateUser).toHaveBeenCalledWith(7);
  });
});
