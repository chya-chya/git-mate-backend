import { ApiProperty } from '@nestjs/swagger';

/**
 * GitHub GraphQL API Response Types for Collection Module
 */

export interface GitHubGraphQLError {
  message: string;
  type?: string;
  path?: string[];
  locations?: { line: number; column: number }[];
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

/**
 * Internal DTOs for Analysis Module
 */
export class ReviewCommentDto {
  @ApiProperty()
  author: string;

  @ApiProperty()
  body: string;

  @ApiProperty()
  createdAt: string;
}

export class ReviewDto {
  @ApiProperty()
  author: string;

  @ApiProperty()
  body: string;

  @ApiProperty()
  state: string;

  @ApiProperty({ type: [ReviewCommentDto] })
  comments: ReviewCommentDto[];
}

export class PullRequestDto {
  @ApiProperty()
  number: number;

  @ApiProperty()
  title: string;

  @ApiProperty()
  body: string;

  @ApiProperty()
  author: string;

  @ApiProperty()
  updatedAt: string;

  @ApiProperty({ type: [ReviewDto] })
  reviews: ReviewDto[];
}

export class CollectedDataDto {
  @ApiProperty()
  githubRepoId: string;

  @ApiProperty({ type: [PullRequestDto] })
  pullRequests: PullRequestDto[];
}
