import { Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { IGithubProvider } from './interfaces/collection.interface';

@Injectable()
export class GithubProvider implements IGithubProvider {
  /**
   * Fetches pull requests using the provided GitHub token.
   */
  async fetchPullRequests(
    owner: string,
    repo: string,
    token: string,
    since?: Date,
    cursor?: string,
  ): Promise<any> {
    const octokit = new Octokit({ auth: token });

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

    return octokit.graphql(query, {
      owner,
      repo,
      cursor,
    });
  }

  /**
   * Fetches all repositories for the authenticated user.
   */
  async fetchRepositories(token: string): Promise<any[]> {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.repos.listForAuthenticatedUser({
      sort: 'updated',
      per_page: 100,
      affiliation: 'owner,collaborator,organization_member',
    });
    return data;
  }
}
