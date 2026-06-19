import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GithubAppInstallUrlDto {
  @ApiProperty()
  url: string;
}

export class GithubAppCallbackQueryDto {
  @ApiProperty({ name: 'installation_id', example: '12345678' })
  @Transform(({ value }) => String(value))
  @Matches(/^\d+$/)
  installation_id: string;

  @ApiPropertyOptional({
    name: 'setup_action',
    enum: ['install', 'update'],
  })
  @IsOptional()
  @IsIn(['install', 'update'])
  setup_action?: string;

  @ApiPropertyOptional({
    description:
      'Signed install state. GitHub omits this value for setup_action=update redirects.',
  })
  @IsOptional()
  @IsString()
  state?: string;
}

export class GithubInstallationDto {
  @ApiProperty()
  installationId: string;

  @ApiProperty()
  accountLogin: string;

  @ApiProperty({ enum: ['USER', 'ORGANIZATION'] })
  accountType: string;

  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED', 'DELETED'] })
  status: string;

  @ApiProperty()
  repositorySelection: string;

  @ApiProperty({
    example:
      'https://github.com/organizations/octo-org/settings/installations/12345678',
    description: 'GitHub settings URL for changing selected repositories',
  })
  settingsUrl: string;

  @ApiProperty()
  membershipVerifiedAt: Date;
}

export class GithubAppConnectionStatusDto {
  @ApiProperty({
    example: true,
    description: 'The request is authenticated with a Git-Mate JWT',
  })
  loggedIn: boolean;

  @ApiProperty({
    example: true,
    description: 'At least one active GitHub App installation is linked',
  })
  githubAppInstalled: boolean;

  @ApiProperty({
    example: false,
    description: 'The user must install or link the GitHub App before syncing',
  })
  requiresInstallation: boolean;

  @ApiProperty({
    example: false,
    description:
      'The user must sign in to GitHub again before organization membership can be verified',
  })
  requiresOAuthReauthorization: boolean;

  @ApiProperty({ example: 1 })
  activeInstallationCount: number;

  @ApiProperty({
    example: '/github-app/installations/install-url',
    description: 'Endpoint that creates a signed GitHub App installation URL',
  })
  installUrlEndpoint: string;
}
