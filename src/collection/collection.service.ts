import {
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
import { EncryptionService } from '../auth/encryption.service';
import { AnalysisService } from '../analysis/analysis.service';

@Injectable()
export class CollectionService implements ICollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly githubProvider: GithubProvider,
    private readonly encryptionService: EncryptionService,
    private readonly analysisService: AnalysisService,
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

    if (repository.ownerId !== userId || !repository.owner.githubToken) {
      throw new ForbiddenException(
        `You do not have permission to sync this repository or token is missing`,
      );
    }

    // Decrypt the token
    const token = this.encryptionService.decrypt(repository.owner.githubToken);

    const [owner, repoName] = repository.fullName.split('/');

    // Fetch data from GitHub using user's token
    const githubData = (await this.githubProvider.fetchPullRequests(
      owner,
      repoName,
      token,
      repository.lastSyncTime || undefined,
    )) as RepositoryQueryResponse;

    // Transform data
    const collectedData: CollectedDataDto = {
      githubRepoId,
      owner,
      repo: repoName,
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

    // Update last sync time
    await this.prisma.repository.update({
      where: { githubRepoId },
      data: { lastSyncTime: new Date() },
    });

    // 🚀 Trigger Analysis (Await so Lambda doesn't exit early)
    // AWS Lambda will freeze execution if we return before this completes.
    await this.analysisService.runAnalysis(
      userId,
      repository.id,
      collectedData,
    );

    return collectedData;
  }

  async estimateSync(
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

    if (repository.ownerId !== userId || !repository.owner.githubToken) {
      throw new ForbiddenException(
        `You do not have permission to access this repository or token is missing`,
      );
    }

    const token = this.encryptionService.decrypt(repository.owner.githubToken);
    const [owner, repoName] = repository.fullName.split('/');

    const githubData = (await this.githubProvider.fetchPullRequests(
      owner,
      repoName,
      token,
      repository.lastSyncTime || undefined,
    )) as RepositoryQueryResponse;

    const rawPrCount = githubData.repository.pullRequests.nodes.length;
    if (rawPrCount === 0) {
      return { prCount: 0, estimatedTokens: 0 };
    }

    const collectedData: CollectedDataDto = {
      githubRepoId,
      owner,
      repo: repoName,
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

  async getRepositories(userId: number): Promise<any[]> {
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.githubToken) {
      throw new ForbiddenException('User token missing');
    }

    const token = this.encryptionService.decrypt(user.githubToken);
    const githubRepos = await this.githubProvider.fetchRepositories(token);
    console.log(
      `Fetched ${githubRepos.length} repos from GitHub for user ${userId}`,
    );

    // Sync GitHub repos with local database
    const upsertPromises = githubRepos.map((repo) =>
      (this.prisma as any).repository.upsert({
        where: { githubRepoId: String(repo.id) },
        update: {
          fullName: repo.full_name,
        },
        create: {
          githubRepoId: String(repo.id),
          fullName: repo.full_name,
          ownerId: userId,
        },
      }),
    );

    await Promise.all(upsertPromises);

    // Return all repositories for this user from DB
    const dbRepos = await (this.prisma as any).repository.findMany({
      where: { ownerId: userId },
      orderBy: { fullName: 'asc' },
    });
    console.log(`Returning ${dbRepos.length} repos from DB for user ${userId}`);
    return dbRepos;
  }
}
