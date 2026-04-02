import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GithubProvider } from './github.provider';
import { ICollectionService } from './interfaces/collection.interface';
import { CollectedDataDto, RepositoryQueryResponse } from './types/github-api.types';
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

  async syncRepository(githubRepoId: string, userId: number): Promise<CollectedDataDto> {
    const repository = await this.prisma.repository.findUnique({
      where: { githubRepoId },
      include: { owner: true },
    });

    if (!repository) {
      throw new NotFoundException(`Repository with ID ${githubRepoId} not found`);
    }

    if (repository.ownerId !== userId || !repository.owner.githubToken) {
      throw new ForbiddenException(`You do not have permission to sync this repository or token is missing`);
    }

    // Decrypt the token
    const token = this.encryptionService.decrypt(repository.owner.githubToken);

    const [owner, repoName] = repository.fullName.split('/');

    // Fetch data from GitHub using user's token
    const githubData = await this.githubProvider.fetchPullRequests(
      owner,
      repoName,
      token,
      repository.lastSyncTime || undefined,
    ) as RepositoryQueryResponse;

    // Transform data
    const collectedData: CollectedDataDto = {
      githubRepoId,
      pullRequests: githubData.repository.pullRequests.nodes.map((pr) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.author.login,
        updatedAt: pr.updatedAt,
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

    // 🚀 Trigger Analysis (Async but we can wait or run in background)
    // For now, we'll run it and return the collected data
    this.analysisService.runAnalysis(userId, repository.id, collectedData)
      .catch(err => console.error('Background analysis failed:', err));

    return collectedData;
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
    return (this.prisma as any).repository.findMany({
      where: { ownerId: userId },
      orderBy: { fullName: 'asc' },
    });
  }
}
