import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  GithubInstallationAccountType,
  GithubInstallationLinkSource,
  GithubInstallationStatus,
} from '@prisma/client';
import { EncryptionService } from '../auth/encryption.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  GithubAppConnectionStatusDto,
  GithubAppInstallUrlDto,
  GithubInstallationDto,
} from './dto/github-app.dto';
import { GithubAppAuthService } from './github-app-auth.service';
import { GithubAppConfig } from './github-app.config';
import {
  GithubInstallationPayload,
  GithubInstallationStatePayload,
} from './github-app.types';

@Injectable()
export class GithubAppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly encryptionService: EncryptionService,
    private readonly githubAuth: GithubAppAuthService,
    private readonly config: GithubAppConfig,
  ) {}

  async createInstallUrl(userId: number): Promise<GithubAppInstallUrlDto> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const installState = await this.prisma.githubAppInstallState.create({
      data: { userId, expiresAt },
    });
    const state = await this.jwtService.signAsync(
      {
        sub: userId,
        jti: installState.id,
        purpose: 'github-app-install',
      },
      {
        secret: this.config.jwtSecret,
        expiresIn: '10m',
      },
    );
    const url = new URL(this.config.installUrl);
    url.searchParams.set('state', state);

    return { url: url.toString() };
  }

  async completeInstallation(
    installationId: string,
    stateToken?: string,
    setupAction?: string,
  ): Promise<string> {
    if (!stateToken) {
      if (setupAction !== 'update') {
        throw new BadRequestException(
          'Installation state is required for new installations',
        );
      }
      return this.completeInstallationUpdate(installationId);
    }

    const state = await this.verifyState(stateToken);
    const installState = await this.prisma.githubAppInstallState.findUnique({
      where: { id: state.jti },
      include: { user: true },
    });

    if (
      !installState ||
      installState.userId !== state.sub ||
      installState.consumedAt ||
      installState.expiresAt <= new Date()
    ) {
      throw new BadRequestException('Installation state is invalid or expired');
    }

    const installation = await this.fetchInstallation(installationId);
    await this.verifyUserAccess(installState.user, installation);

    await this.prisma.$transaction(async (tx) => {
      const savedInstallation = await tx.githubInstallation.upsert({
        where: { githubInstallationId: installationId },
        update: this.toInstallationData(installation),
        create: {
          githubInstallationId: installationId,
          ...this.toInstallationData(installation),
        },
      });

      await tx.userGithubInstallation.upsert({
        where: {
          userId_installationId: {
            userId: installState.userId,
            installationId: savedInstallation.id,
          },
        },
        update: {
          source: GithubInstallationLinkSource.INSTALL_CALLBACK,
          membershipVerifiedAt: new Date(),
        },
        create: {
          userId: installState.userId,
          installationId: savedInstallation.id,
          source: GithubInstallationLinkSource.INSTALL_CALLBACK,
          membershipVerifiedAt: new Date(),
        },
      });

      await tx.githubAppInstallState.update({
        where: { id: installState.id },
        data: { consumedAt: new Date() },
      });
    });

    const redirectUrl = new URL('/repositories', this.config.frontendUrl);
    redirectUrl.searchParams.set('status', 'installed');
    redirectUrl.searchParams.set('installation_id', installationId);
    return redirectUrl.toString();
  }

  private async completeInstallationUpdate(
    installationId: string,
  ): Promise<string> {
    const installation = await this.fetchInstallation(installationId);
    await this.prisma.githubInstallation.upsert({
      where: { githubInstallationId: installationId },
      update: this.toInstallationData(installation),
      create: {
        githubInstallationId: installationId,
        ...this.toInstallationData(installation),
      },
    });

    const redirectUrl = new URL('/repositories', this.config.frontendUrl);
    redirectUrl.searchParams.set('status', 'updated');
    redirectUrl.searchParams.set('installation_id', installationId);
    return redirectUrl.toString();
  }

  async getInstallations(userId: number): Promise<GithubInstallationDto[]> {
    await this.syncUserInstallations(userId);

    const links = await this.prisma.userGithubInstallation.findMany({
      where: {
        userId,
        installation: {
          status: { not: GithubInstallationStatus.DELETED },
        },
      },
      include: { installation: true },
      orderBy: { installation: { accountLogin: 'asc' } },
    });

    return links.map(({ installation, membershipVerifiedAt }) => ({
      installationId: installation.githubInstallationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      status: installation.status,
      repositorySelection: installation.repositorySelection,
      settingsUrl: this.createSettingsUrl(
        installation.githubInstallationId,
        installation.accountLogin,
        installation.accountType,
      ),
      membershipVerifiedAt,
    }));
  }

  async getConnectionStatus(
    userId: number,
  ): Promise<GithubAppConnectionStatusDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        githubToken: true,
        _count: {
          select: {
            githubInstallations: {
              where: {
                installation: {
                  status: GithubInstallationStatus.ACTIVE,
                },
              },
            },
          },
        },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const activeInstallationCount = user._count.githubInstallations;
    return {
      loggedIn: true,
      githubAppInstalled: activeInstallationCount > 0,
      requiresInstallation: activeInstallationCount === 0,
      requiresOAuthReauthorization: !user.githubToken,
      activeInstallationCount,
      installUrlEndpoint: '/github-app/installations/install-url',
    };
  }

  private async syncUserInstallations(userId: number): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!user.githubToken) {
      throw new ForbiddenException('GitHub OAuth token is missing');
    }

    const token = this.encryptionService.decrypt(user.githubToken);
    const userOctokit = this.githubAuth.createUserOctokit(token);
    const organizations: Array<{ login: string }> = [];
    for (let page = 1; ; page += 1) {
      const { data } = await userOctokit.rest.orgs.listForAuthenticatedUser({
        per_page: 100,
        page,
      });
      const pageOrganizations = data as Array<{ login: string }>;
      organizations.push(...pageOrganizations);
      if (pageOrganizations.length < 100) {
        break;
      }
    }
    const organizationLogins = new Set(
      organizations.map((organization) => organization.login.toLowerCase()),
    );
    const appOctokit = this.githubAuth.createAppOctokit();
    const rawInstallations: GithubInstallationPayload[] = [];
    for (let page = 1; ; page += 1) {
      const { data } = await appOctokit.rest.apps.listInstallations({
        per_page: 100,
        page,
      });
      const pageInstallations = data as GithubInstallationPayload[];
      rawInstallations.push(...pageInstallations);
      if (pageInstallations.length < 100) {
        break;
      }
    }
    const accessibleInstallationIds: number[] = [];

    for (const installation of rawInstallations) {
      if (!this.isAccessible(user.githubId, organizationLogins, installation)) {
        continue;
      }

      const savedInstallation = await this.prisma.githubInstallation.upsert({
        where: { githubInstallationId: String(installation.id) },
        update: this.toInstallationData(installation),
        create: {
          githubInstallationId: String(installation.id),
          ...this.toInstallationData(installation),
        },
      });
      accessibleInstallationIds.push(savedInstallation.id);

      await this.prisma.userGithubInstallation.upsert({
        where: {
          userId_installationId: {
            userId,
            installationId: savedInstallation.id,
          },
        },
        update: {
          membershipVerifiedAt: new Date(),
        },
        create: {
          userId,
          installationId: savedInstallation.id,
          source: GithubInstallationLinkSource.AUTO_DISCOVERY,
          membershipVerifiedAt: new Date(),
        },
      });
    }

    await this.prisma.userGithubInstallation.deleteMany({
      where: {
        userId,
        installationId: { notIn: accessibleInstallationIds },
      },
    });
  }

  private async verifyState(
    stateToken: string,
  ): Promise<GithubInstallationStatePayload> {
    try {
      const payload =
        await this.jwtService.verifyAsync<GithubInstallationStatePayload>(
          stateToken,
          { secret: this.config.jwtSecret },
        );
      if (
        payload.purpose !== 'github-app-install' ||
        !payload.jti ||
        !payload.sub
      ) {
        throw new Error('Invalid state payload');
      }
      return payload;
    } catch {
      throw new BadRequestException('Installation state is invalid or expired');
    }
  }

  private async fetchInstallation(
    installationId: string,
  ): Promise<GithubInstallationPayload> {
    try {
      const octokit = this.githubAuth.createAppOctokit();
      const { data } = await octokit.rest.apps.getInstallation({
        installation_id: Number(installationId),
      });
      return data as GithubInstallationPayload;
    } catch {
      throw new BadRequestException(
        'GitHub installation could not be verified',
      );
    }
  }

  private async verifyUserAccess(
    user: {
      githubId: string;
      username: string;
      githubToken: string | null;
    },
    installation: GithubInstallationPayload,
  ): Promise<void> {
    const account = this.requireAccount(installation);
    if (account.type === 'User') {
      if (String(account.id) !== user.githubId) {
        throw new ForbiddenException(
          'The installation does not belong to this GitHub user',
        );
      }
      return;
    }

    if (!user.githubToken) {
      throw new ForbiddenException('GitHub OAuth token is missing');
    }

    try {
      const token = this.encryptionService.decrypt(user.githubToken);
      const octokit = this.githubAuth.createUserOctokit(token);
      await octokit.rest.orgs.checkMembershipForUser({
        org: account.login,
        username: user.username,
      });
    } catch {
      throw new ForbiddenException(
        'The GitHub user is not a member of this organization',
      );
    }
  }

  private isAccessible(
    githubId: string,
    organizationLogins: Set<string>,
    installation: GithubInstallationPayload,
  ): boolean {
    const account = installation.account;
    if (!account) {
      return false;
    }
    if (account.type === 'User') {
      return String(account.id) === githubId;
    }
    return organizationLogins.has(account.login.toLowerCase());
  }

  private createSettingsUrl(
    installationId: string,
    accountLogin: string,
    accountType: GithubInstallationAccountType,
  ): string {
    if (accountType === GithubInstallationAccountType.ORGANIZATION) {
      return `https://github.com/organizations/${accountLogin}/settings/installations/${installationId}`;
    }

    return `https://github.com/settings/installations/${installationId}`;
  }

  private toInstallationData(installation: GithubInstallationPayload) {
    const account = this.requireAccount(installation);
    return {
      accountId: String(account.id),
      accountLogin: account.login,
      accountType:
        account.type === 'Organization'
          ? GithubInstallationAccountType.ORGANIZATION
          : GithubInstallationAccountType.USER,
      repositorySelection: installation.repository_selection,
      status: installation.suspended_at
        ? GithubInstallationStatus.SUSPENDED
        : GithubInstallationStatus.ACTIVE,
      suspendedAt: this.toDate(installation.suspended_at),
      deletedAt: null,
      githubCreatedAt: this.toDate(installation.created_at),
      githubUpdatedAt: this.toDate(installation.updated_at),
    };
  }

  private requireAccount(installation: GithubInstallationPayload) {
    if (!installation.account) {
      throw new BadRequestException('GitHub installation account is missing');
    }
    return installation.account;
  }

  private toDate(value: string | null): Date | null {
    return value ? new Date(value) : null;
  }
}
