import { Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { IGithubProvider } from './interfaces/collection.interface';
import { normalizeGithubRequestError } from './github-errors';
import {
  PullRequestReviewsQueryResponse,
  RepositoryQueryResponse,
  ReviewCommentsQueryResponse,
} from './types/github-api.types';

@Injectable()
export class GithubProvider implements IGithubProvider {
  /**
   * Fetches pull requests using the provided GitHub token.
   */
  async fetchPullRequests(
    owner: string,
    repo: string,
    octokit: Octokit,
    cursor?: string,
  ): Promise<RepositoryQueryResponse> {
    const query = `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequests(first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              id
              number
              title
              body
              state
              permalink
              author {
                login
              }
              createdAt
              updatedAt
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    `;

    return this.graphql(octokit, query, { owner, repo, cursor });
  }

  async fetchPullRequestReviews(
    pullRequestId: string,
    octokit: Octokit,
    cursor?: string,
  ): Promise<PullRequestReviewsQueryResponse> {
    const query = `
      query($pullRequestId: ID!, $cursor: String) {
        node(id: $pullRequestId) {
          ... on PullRequest {
            reviews(first: 50, after: $cursor) {
              nodes {
                id
                body
                state
                author { login }
              }
              pageInfo { endCursor hasNextPage }
            }
          }
        }
      }
    `;

    return this.graphql(octokit, query, { pullRequestId, cursor });
  }

  async fetchReviewComments(
    reviewId: string,
    octokit: Octokit,
    cursor?: string,
  ): Promise<ReviewCommentsQueryResponse> {
    const query = `
      query($reviewId: ID!, $cursor: String) {
        node(id: $reviewId) {
          ... on PullRequestReview {
            comments(first: 50, after: $cursor) {
              nodes {
                id
                body
                author { login }
                createdAt
              }
              pageInfo { endCursor hasNextPage }
            }
          }
        }
      }
    `;

    return this.graphql(octokit, query, { reviewId, cursor });
  }

  private async graphql<T>(
    octokit: Octokit,
    query: string,
    variables: Record<string, string | undefined>,
  ): Promise<T> {
    try {
      return await octokit.graphql<T>(query, variables);
    } catch (error) {
      throw normalizeGithubRequestError(error);
    }
  }
}
