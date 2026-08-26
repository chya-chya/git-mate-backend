import { Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { IGithubProvider } from './interfaces/collection.interface';
import { RepositoryQueryResponse } from './types/github-api.types';

@Injectable()
export class GithubProvider implements IGithubProvider {
  /**
   * Fetches pull requests using the provided GitHub token.
   */
  async fetchPullRequests(
    owner: string,
    repo: string,
    octokit: Octokit,
    since?: Date,
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
              reviews(first: 50) {
                nodes {
                  id
                  body
                  state
                  author {
                    login
                  }
                  comments(first: 50) {
                    nodes {
                      id
                      body
                      author {
                        login
                      }
                      createdAt
                    }
                  }
                }
              }
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    `;

    return octokit.graphql<RepositoryQueryResponse>(query, {
      owner,
      repo,
      cursor,
    });
  }
}
