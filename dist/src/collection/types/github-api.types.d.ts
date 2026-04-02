export interface GitHubGraphQLError {
    message: string;
    type?: string;
    path?: string[];
    locations?: {
        line: number;
        column: number;
    }[];
}
export interface GitHubGraphQLResponse<T> {
    data?: T;
    errors?: GitHubGraphQLError[];
}
export interface ReviewCommentNode {
    id: string;
    body: string;
    author: {
        login: string;
    };
    createdAt: string;
}
export interface PullRequestNode {
    id: string;
    number: number;
    title: string;
    body: string;
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    author: {
        login: string;
    };
    createdAt: string;
    updatedAt: string;
    reviews: {
        nodes: Array<{
            id: string;
            body: string;
            state: string;
            author: {
                login: string;
            };
            comments: {
                nodes: ReviewCommentNode[];
            };
        }>;
    };
}
export interface RepositoryQueryResponse {
    repository: {
        pullRequests: {
            totalCount: number;
            pageInfo: {
                endCursor: string;
                hasNextPage: boolean;
            };
            nodes: PullRequestNode[];
        };
    };
}
export declare class ReviewCommentDto {
    author: string;
    body: string;
    createdAt: string;
}
export declare class ReviewDto {
    author: string;
    body: string;
    state: string;
    comments: ReviewCommentDto[];
}
export declare class PullRequestDto {
    number: number;
    title: string;
    body: string;
    author: string;
    updatedAt: string;
    reviews: ReviewDto[];
}
export declare class CollectedDataDto {
    githubRepoId: string;
    pullRequests: PullRequestDto[];
}
