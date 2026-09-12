import {
  CollectedDataDto,
  PullRequestReviewsQueryResponse,
  RepositoryQueryResponse,
  ReviewCommentsQueryResponse,
} from '../types/github-api.types';
import { Octokit } from '@octokit/rest';

export interface IGithubProvider {
  fetchPullRequests(
    owner: string,
    repo: string,
    octokit: Octokit,
    cursor?: string,
  ): Promise<RepositoryQueryResponse>;
  fetchPullRequestReviews(
    pullRequestId: string,
    octokit: Octokit,
    cursor?: string,
  ): Promise<PullRequestReviewsQueryResponse>;
  fetchReviewComments(
    reviewId: string,
    octokit: Octokit,
    cursor?: string,
  ): Promise<ReviewCommentsQueryResponse>;
}

export interface ICollectionService {
  syncRepository(
    githubRepoId: string,
    userId: number,
  ): Promise<CollectedDataDto>;
}
