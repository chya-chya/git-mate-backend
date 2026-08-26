import {
  ConflictException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ICollectionService } from './interfaces/collection.interface';
import {
  CollectedDataDto,
  EstimateResponseDto,
} from './types/github-api.types';
import { AnalysisService } from '../analysis/analysis.service';
import { GithubAppService } from '../github-app/github-app.service';
import { GithubInstallationTokenService } from '../github-app/github-installation-token.service';
import { Repository } from '@prisma/client';
import { ActiveAnalysisJobExistsError } from '../analysis-job/analysis-job.repository';
import { RepositoryCollectionService } from './repository-collection.service';

@Injectable()
export class CollectionService implements ICollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repositoryCollection: RepositoryCollectionService,
    private readonly analysisService: AnalysisService,
    private readonly githubAppService: GithubAppService,
    private readonly installationTokens: GithubInstallationTokenService,
  ) {}

  async syncRepository(
    githubRepoId: string,
    userId: number,
  ): Promise<CollectedDataDto> {
    const repository = await this.prisma.repository.findUnique({
      where: { githubRepoId },
      include: { owner: true },
    });

    if (!repository) {
      throw new NotFoundException(
        `Repository with ID ${githubRepoId} not found`,
      );
    }

    if (repository.ownerId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to sync this repository',
      );
    }

    const syncStartedAt = new Date();
    const collectedData = await this.repositoryCollection.collect({
      userId,
      githubRepoId,
      fullName: repository.fullName,
      targetUser: repository.owner.username,
      sourceCursor: repository.lastSyncTime ?? undefined,
    });

    // 🚀 Trigger Analysis (Await so Lambda doesn't exit early)
    // AWS Lambda will freeze execution if we return before this completes.
    try {
      await this.analysisService.runAnalysis(
        userId,
        repository.id,
        collectedData,
        (tx) =>
          tx.repository.updateMany({
            where: {
              githubRepoId,
              OR: [
                { lastSyncTime: null },
                { lastSyncTime: { lt: syncStartedAt } },
              ],
            },
            data: { lastSyncTime: syncStartedAt },
          }),
      );
    } catch (error) {
      if (error instanceof ActiveAnalysisJobExistsError) {
        throw new ConflictException({
          code: 'ACTIVE_JOB_EXISTS',
          message: 'An active analysis job already exists for this repository.',
        });
      }
      throw error;
    }

    return collectedData;
  }

  async estimateCost(
    githubRepoId: string,
    userId: number,
  ): Promise<EstimateResponseDto> {
    const repository = await this.prisma.repository.findUnique({
      where: { githubRepoId },
      include: { owner: true },
    });

    if (!repository) {
      throw new NotFoundException(
        `Repository with ID ${githubRepoId} not found`,
      );
    }

    if (repository.ownerId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to access this repository',
      );
    }

    const collectedData = await this.repositoryCollection.collect({
      userId,
      githubRepoId,
      fullName: repository.fullName,
      targetUser: repository.owner.username,
      sourceCursor: repository.lastSyncTime ?? undefined,
    });

    const rawPrCount = collectedData.pullRequests.length;
    if (rawPrCount === 0) {
      return { prCount: 0, estimatedTokens: 0 };
    }

    const { prCount, estimatedTokens } =
      await this.analysisService.estimateTokens(collectedData);

    return { prCount, estimatedTokens };
  }

  async getRepositories(userId: number): Promise<Repository[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new ForbiddenException('User not found');
    }

    await this.githubAppService.getInstallations(userId);
    const githubRepos = await this.installationTokens.getAvailableRepos(userId);

    const upsertPromises = githubRepos.map((repo) =>
      this.prisma.repository.upsert({
        where: { githubRepoId: String(repo.id) },
        update: {
          fullName: repo.fullName,
          ownerId: userId,
        },
        create: {
          githubRepoId: String(repo.id),
          fullName: repo.fullName,
          ownerId: userId,
        },
      }),
    );

    await Promise.all(upsertPromises);

    const accessibleRepositoryIds = githubRepos.map(({ id }) => String(id));
    return this.prisma.repository.findMany({
      where: {
        ownerId: userId,
        githubRepoId: { in: accessibleRepositoryIds },
      },
      orderBy: { fullName: 'asc' },
    });
  }
}
