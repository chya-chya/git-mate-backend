import { CollectedDataDto } from '../types/github-api.types';

export interface IGithubProvider {
  fetchPullRequests(
    owner: string,
    repo: string,
    token: string,
    since?: Date,
    cursor?: string,
  ): Promise<any>;
}

export interface ICollectionService {
  syncRepository(
    githubRepoId: string,
    userId: number,
  ): Promise<CollectedDataDto>;
}
