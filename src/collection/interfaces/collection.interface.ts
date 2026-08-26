import {
  CollectedDataDto,
  RepositoryQueryResponse,
} from '../types/github-api.types';
import { Octokit } from '@octokit/rest';

export interface IGithubProvider {
  fetchPullRequests(
    owner: string,
    repo: string,
    octokit: Octokit,
    since?: Date,
    cursor?: string,
  ): Promise<RepositoryQueryResponse>;
}

export interface ICollectionService {
  syncRepository(
    githubRepoId: string,
    userId: number,
  ): Promise<CollectedDataDto>;
}
