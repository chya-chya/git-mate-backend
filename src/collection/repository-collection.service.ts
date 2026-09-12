import { Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { GithubInstallationTokenService } from '../github-app/github-installation-token.service';
import { GithubProvider } from './github.provider';
import { CollectedDataDto } from './types/github-api.types';

export interface CollectRepositoryInput {
  userId: number;
  githubRepoId: string;
  fullName: string;
  targetUser: string;
  sourceCursor?: Date;
}

export class InvalidRepositoryCollectionInputError extends Error {
  constructor() {
    super('Repository collection input is invalid.');
    this.name = InvalidRepositoryCollectionInputError.name;
  }
}

@Injectable()
export class RepositoryCollectionService {
  constructor(
    private readonly githubProvider: GithubProvider,
    private readonly installationTokens: GithubInstallationTokenService,
  ) {}

  async collect(input: CollectRepositoryInput): Promise<CollectedDataDto> {
    const [owner, repo, ...extraParts] = input.fullName.split('/');
    if (
      !Number.isInteger(input.userId) ||
      input.userId <= 0 ||
      input.githubRepoId.length === 0 ||
      !owner ||
      !repo ||
      extraParts.length > 0 ||
      input.targetUser.length === 0 ||
      (input.sourceCursor !== undefined &&
        Number.isNaN(input.sourceCursor.getTime()))
    ) {
      throw new InvalidRepositoryCollectionInputError();
    }

    const githubData = await this.installationTokens.executeForRepository(
      input.userId,
      input.githubRepoId,
      (octokit: Octokit) =>
        this.githubProvider.fetchPullRequests(
          owner,
          repo,
          octokit,
          input.sourceCursor,
        ),
    );

    const pullRequests = githubData.repository.pullRequests.nodes.filter(
      (pullRequest) =>
        input.sourceCursor === undefined ||
        Date.parse(pullRequest.updatedAt) > input.sourceCursor.getTime(),
    );

    return {
      githubRepoId: input.githubRepoId,
      owner,
      repo,
      targetUser: input.targetUser,
      pullRequests: pullRequests.map((pr) => ({
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
  }
}
