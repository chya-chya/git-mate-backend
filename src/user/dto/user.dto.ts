import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';

export class UserResponseDto {
  @ApiProperty({ example: 1, description: 'User index ID' })
  id: number;

  @ApiProperty({ example: 'octocat', description: 'GitHub username' })
  username: string;

  @ApiProperty({
    example: 'https://avatars.githubusercontent.com/u/1?v=4',
    description: 'GitHub avatar URL',
    nullable: true,
  })
  avatarUrl: string | null;

  @ApiProperty({ example: 100000, description: 'Available analysis tokens' })
  availableTokens: number;

  @ApiProperty({
    example: '2024-01-01T00:00:00.000Z',
    description: 'Account creation date',
  })
  createdAt: Date;
}

export class UserTokensDto {
  @ApiProperty({ example: 100000, description: 'Available analysis tokens' })
  availableTokens: number;
}

export class DeactivateUserResponseDto {
  @ApiProperty({
    example: true,
    description: 'Whether account deactivation succeeded',
  })
  success: boolean;

  @ApiProperty({
    enum: UserStatus,
    example: UserStatus.DEACTIVATED,
    description: 'Updated account status',
  })
  status: UserStatus;
}
