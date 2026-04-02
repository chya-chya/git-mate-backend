import { IGithubProvider } from './interfaces/collection.interface';
export declare class GithubProvider implements IGithubProvider {
    fetchPullRequests(owner: string, repo: string, token: string, since?: Date, cursor?: string): Promise<any>;
    fetchRepositories(token: string): Promise<any[]>;
}
