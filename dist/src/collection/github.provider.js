"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GithubProvider = void 0;
const common_1 = require("@nestjs/common");
const rest_1 = require("@octokit/rest");
let GithubProvider = class GithubProvider {
    async fetchPullRequests(owner, repo, token, since, cursor) {
        const octokit = new rest_1.Octokit({ auth: token });
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
    async fetchRepositories(token) {
        const octokit = new rest_1.Octokit({ auth: token });
        const { data } = await octokit.repos.listForAuthenticatedUser({
            sort: 'updated',
            per_page: 100,
            affiliation: 'owner,collaborator,organization_member',
        });
        return data;
    }
};
exports.GithubProvider = GithubProvider;
exports.GithubProvider = GithubProvider = __decorate([
    (0, common_1.Injectable)()
], GithubProvider);
//# sourceMappingURL=github.provider.js.map