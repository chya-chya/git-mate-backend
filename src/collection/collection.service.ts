import {
  ConflictException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GithubProvider } from './github.provider';
import { ICollectionService } from './interfaces/collection.interface';
import {
  CollectedDataDto,
  RepositoryQueryResponse,
  EstimateResponseDto,
} from './types/github-api.types';
import { AnalysisService } from '../analysis/analysis.service';
import { GithubAppService } from '../github-app/github-app.service';
import { GithubInstallationTokenService } from '../github-app/github-installation-token.service';
import { Repository } from '@prisma/client';
import { ActiveAnalysisJobExistsError } from '../analysis-job/analysis-job.repository';

@Injectable()
export class CollectionService implements ICollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly githubProvider: GithubProvider,
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
    const [owner, repoName] = repository.fullName.split('/');

    const githubData =
      await this.installationTokens.executeForRepository<RepositoryQueryResponse>(
        userId,
        githubRepoId,
        (octokit) =>
          this.githubProvider.fetchPullRequests(
            owner,
            repoName,
            octokit,
            repository.lastSyncTime ?? undefined,
          ) as Promise<RepositoryQueryResponse>,
      );

    // Transform data
    const collectedData: CollectedDataDto = {
      githubRepoId,
      owner,
      repo: repoName,
      targetUser: repository.owner.username,
      pullRequests: githubData.repository.pullRequests.nodes.map((pr) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.author.login,
        updatedAt: pr.updatedAt,
        permalink: pr.permalink,
        reviews: pr.reviews.nodes.map((review) => ({
          author: review.author.login,
          body: review.body,
          state: review.state,
          comments: review.comments.nodes.map((comment) => ({
            author: comment.author.login,
            body: comment.body,
            createdAt: comment.createdAt,
          })),
        })),
      })),
    };

    // 🚀 Trigger Analysis (Await so Lambda doesn't exit early)
    // AWS Lambda will freeze execution if we return before this completes.
    try {
      await this.analysisService.runAnalysis(
        userId,
        repository.id,
        collectedData,
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

    await this.prisma.repository.updateMany({
      where: {
        githubRepoId,
        OR: [{ lastSyncTime: null }, { lastSyncTime: { lt: syncStartedAt } }],
      },
      data: { lastSyncTime: syncStartedAt },
    });

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

    const [owner, repoName] = repository.fullName.split('/');

    const githubData =
      await this.installationTokens.executeForRepository<RepositoryQueryResponse>(
        userId,
        githubRepoId,
        (octokit) =>
          this.githubProvider.fetchPullRequests(
            owner,
            repoName,
            octokit,
            repository.lastSyncTime ?? undefined,
          ) as Promise<RepositoryQueryResponse>,
      );

    const rawPrCount = githubData.repository.pullRequests.nodes.length;
    if (rawPrCount === 0) {
      return { prCount: 0, estimatedTokens: 0 };
    }

    const collectedData: CollectedDataDto = {
      githubRepoId,
      owner,
      repo: repoName,
      targetUser: repository.owner.username,
      pullRequests: githubData.repository.pullRequests.nodes.map((pr) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.author.login,
        updatedAt: pr.updatedAt,
        permalink: pr.permalink,
        reviews: pr.reviews.nodes.map((review) => ({
          author: review.author.login,
          body: review.body,
          state: review.state,
          comments: review.comments.nodes.map((comment) => ({
            author: comment.author.login,
            body: comment.body,
            createdAt: comment.createdAt,
          })),
        })),
      })),
    };

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
