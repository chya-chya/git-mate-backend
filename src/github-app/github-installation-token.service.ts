import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GithubInstallationStatus } from '@prisma/client';
import { Octokit } from '@octokit/rest';
import { PrismaService } from '../prisma/prisma.service';
import { GithubAppAuthService } from './github-app-auth.service';

interface CachedInstallationToken {
  token: string;
  expiresAt: Date;
}

export interface InstallationRepository {
  id: number;
  fullName: string;
  private: boolean;
  installationId: string;
}

@Injectable()
export class GithubInstallationTokenService {
  private readonly tokenCache = new Map<string, CachedInstallationToken>();
  private readonly refreshBufferMs = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly githubAppAuth: GithubAppAuthService,
  ) {}

  async listAccessibleRepositories(
    userId: number,
  ): Promise<InstallationRepository[]> {
    const installations = await this.getActiveInstallations(userId);
    const repositories = await Promise.all(
      installations.map(async ({ githubInstallationId }) => {
        const installationRepositories: InstallationRepository[] = [];

        for (let page = 1; ; page += 1) {
          const data = await this.executeWithRetry(
            githubInstallationId,
            async (octokit) =>
              (
                await octokit.rest.apps.listReposAccessibleToInstallation({
                  per_page: 100,
                  page,
                })
              ).data,
          );
          installationRepositories.push(
            ...data.repositories.map((repository) => ({
              id: repository.id,
              fullName: repository.full_name,
              private: repository.private,
              installationId: githubInstallationId,
            })),
          );
          if (data.repositories.length < 100) {
            break;
          }
        }

        return installationRepositories;
      }),
    );

    const uniqueRepositories = new Map<number, InstallationRepository>();
    for (const repository of repositories.flat()) {
      uniqueRepositories.set(repository.id, repository);
    }
    return [...uniqueRepositories.values()];
  }

  async executeForRepository<T>(
    userId: number,
    githubRepoId: string,
    operation: (octokit: Octokit) => Promise<T>,
  ): Promise<T> {
    const repository = (await this.listAccessibleRepositories(userId)).find(
      ({ id }) => String(id) === githubRepoId,
    );
    if (!repository) {
      throw new ForbiddenException(
        'Repository is not accessible through an active GitHub App installation',
      );
    }

    return this.executeWithRetry(repository.installationId, operation);
  }

  private async executeWithRetry<T>(
    installationId: string,
    operation: (octokit: Octokit) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(
        await this.createInstallationOctokit(installationId),
      );
    } catch (error) {
      if (!this.isUnauthorized(error)) {
        throw error;
      }
      this.tokenCache.delete(installationId);
      return operation(await this.createInstallationOctokit(installationId));
    }
  }

  private async createInstallationOctokit(
    installationId: string,
  ): Promise<Octokit> {
    const token = await this.getInstallationToken(installationId);
    return new Octokit({ auth: token });
  }

  private async getInstallationToken(installationId: string): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (
      cached &&
      cached.expiresAt.getTime() - this.refreshBufferMs > Date.now()
    ) {
      return cached.token;
    }

    const installation = await this.prisma.githubInstallation.findFirst({
      where: {
        githubInstallationId: installationId,
        status: GithubInstallationStatus.ACTIVE,
      },
      select: { id: true },
    });
    if (!installation) {
      this.tokenCache.delete(installationId);
      throw new ForbiddenException(
        'GitHub App installation is deleted, suspended, or unavailable',
      );
    }

    const appOctokit = this.githubAppAuth.createAppOctokit();
    const { data } = await appOctokit.rest.apps.createInstallationAccessToken({
      installation_id: Number(installationId),
    });
    this.tokenCache.set(installationId, {
      token: data.token,
      expiresAt: new Date(data.expires_at),
    });
    return data.token;
  }

  private async getActiveInstallations(userId: number) {
    const links = await this.prisma.userGithubInstallation.findMany({
      where: {
        userId,
        installation: {
          status: GithubInstallationStatus.ACTIVE,
        },
      },
      select: {
        installation: {
          select: {
            githubInstallationId: true,
          },
        },
      },
    });
    if (links.length === 0) {
      throw new ForbiddenException({
        code: 'GITHUB_APP_INSTALLATION_REQUIRED',
        message: 'Install or reconnect the GitHub App to access repositories',
        installUrlEndpoint: '/github-app/installations/install-url',
      });
    }
    return links.map(({ installation }) => installation);
  }

  private isUnauthorized(error: unknown): boolean {
    if (error instanceof UnauthorizedException) {
      return true;
    }
    return (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 401
    );
  }
}
