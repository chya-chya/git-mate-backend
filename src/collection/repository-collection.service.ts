import { Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { GithubInstallationTokenService } from '../github-app/github-installation-token.service';
import {
  COLLECTION_LIMITS,
  InputLimitExceededError,
} from './collection-limits';
import { GithubPaginationError, InvalidGithubDateError } from './github-errors';
import { GithubProvider } from './github.provider';
import {
  CollectedDataDto,
  PageInfo,
  PullRequestDto,
  PullRequestNode,
  ReviewCommentDto,
  ReviewDto,
} from './types/github-api.types';

const DELETED_GITHUB_AUTHOR = '[deleted]';
const GITHUB_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface CollectRepositoryInput {
  userId: number;
  githubRepoId: string;
  fullName: string;
  targetUser: string;
  sourceCursor?: Date;
  collectionCutoff: Date;
  onPage?: () => Promise<void>;
}

export class InvalidRepositoryCollectionInputError extends Error {
  constructor() {
    super('Repository collection input is invalid.');
    this.name = InvalidRepositoryCollectionInputError.name;
  }
}

interface CollectionState {
  reviewNodes: Map<string, string>;
  reviewOwners: Map<string, string>;
  commentNodes: Map<string, string>;
  commentOwners: Map<string, string>;
  reviewAndCommentCount: number;
}

@Injectable()
export class RepositoryCollectionService {
  constructor(
    private readonly githubProvider: GithubProvider,
    private readonly installationTokens: GithubInstallationTokenService,
  ) {}

  async collect(input: CollectRepositoryInput): Promise<CollectedDataDto> {
    const [owner, repo, ...extraParts] = input.fullName.split('/');
    if (
      !Number.isInteger(input.userId) ||
      input.userId <= 0 ||
      input.githubRepoId.length === 0 ||
      !owner ||
      !repo ||
      extraParts.length > 0 ||
      input.targetUser.length === 0 ||
      !this.isValidDate(input.collectionCutoff) ||
      (input.sourceCursor !== undefined &&
        (!this.isValidDate(input.sourceCursor) ||
          input.sourceCursor > input.collectionCutoff))
    ) {
      throw new InvalidRepositoryCollectionInputError();
    }

    return this.installationTokens.executeForRepository(
      input.userId,
      input.githubRepoId,
      (octokit: Octokit) => this.collectAttempt(input, owner, repo, octokit),
    );
  }

  private async collectAttempt(
    input: CollectRepositoryInput,
    owner: string,
    repo: string,
    octokit: Octokit,
  ): Promise<CollectedDataDto> {
    const pullRequestNodes = await this.collectPullRequests(
      input,
      owner,
      repo,
      octokit,
    );
    const state: CollectionState = {
      reviewNodes: new Map(),
      reviewOwners: new Map(),
      commentNodes: new Map(),
      commentOwners: new Map(),
      reviewAndCommentCount: 0,
    };
    const pullRequests: PullRequestDto[] = [];

    for (const pullRequest of pullRequestNodes) {
      const provisionalState: CollectionState = {
        reviewNodes: new Map(),
        reviewOwners: new Map(),
        commentNodes: new Map(),
        commentOwners: new Map(),
        reviewAndCommentCount: 0,
      };
      const reviews = await this.collectReviews(
        pullRequest.id,
        input.collectionCutoff,
        octokit,
        input.onPage,
        provisionalState,
      );
      if (reviews === null) {
        continue;
      }
      this.mergeCollectionState(state, provisionalState);
      pullRequests.push({
        number: pullRequest.number,
        title: pullRequest.title,
        body: pullRequest.body,
        author: this.authorLogin(pullRequest.author),
        updatedAt: pullRequest.updatedAt,
        permalink: pullRequest.permalink,
        reviews,
      });
    }

    return {
      githubRepoId: input.githubRepoId,
      owner,
      repo,
      targetUser: input.targetUser,
      pullRequests,
    };
  }

  private async collectPullRequests(
    input: CollectRepositoryInput,
    owner: string,
    repo: string,
    octokit: Octokit,
  ): Promise<PullRequestNode[]> {
    const collected: PullRequestNode[] = [];
    const seenNodes = new Map<string, string>();
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;
    let reachedSourceCursor = false;

    while (true) {
      const response = await this.githubProvider.fetchPullRequests(
        owner,
        repo,
        octokit,
        cursor,
      );
      const connection = response.repository?.pullRequests;
      this.assertConnection(
        connection?.nodes,
        connection?.pageInfo,
        'pull request',
      );
      await input.onPage?.();

      for (const pullRequest of connection.nodes) {
        const firstObservation = this.observeUniqueNode(
          pullRequest,
          seenNodes,
          'pull request',
        );
        const updatedAt = this.parseGithubDate(
          pullRequest.updatedAt,
          'pull request updatedAt',
        );
        if (
          input.sourceCursor !== undefined &&
          updatedAt.getTime() <= input.sourceCursor.getTime()
        ) {
          reachedSourceCursor = true;
          break;
        }
        if (
          firstObservation &&
          updatedAt.getTime() <= input.collectionCutoff.getTime()
        ) {
          collected.push(pullRequest);
          if (collected.length > COLLECTION_LIMITS.changedPullRequests) {
            throw new InputLimitExceededError(
              'changed pull requests',
              COLLECTION_LIMITS.changedPullRequests,
              collected.length,
            );
          }
        }
      }

      if (reachedSourceCursor || !connection.pageInfo.hasNextPage) {
        return collected;
      }
      cursor = this.nextCursor(
        connection.pageInfo,
        cursor,
        connection.nodes.length,
        visitedCursors,
        'pull request',
      );
    }
  }

  private async collectReviews(
    pullRequestId: string,
    collectionCutoff: Date,
    octokit: Octokit,
    onPage: (() => Promise<void>) | undefined,
    state: CollectionState,
  ): Promise<ReviewDto[] | null> {
    const reviews: ReviewDto[] = [];
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const response = await this.githubProvider.fetchPullRequestReviews(
        pullRequestId,
        octokit,
        cursor,
      );
      const node = response.node;
      if (!node) {
        throw new GithubPaginationError('review', 'parent node is missing');
      }
      this.assertParentId(node.id, pullRequestId, 'review');
      const currentUpdatedAt = this.parseGithubDate(
        node.updatedAt,
        'pull request updatedAt',
      );
      const connection = node.reviews;
      this.assertConnection(connection?.nodes, connection?.pageInfo, 'review');
      await onPage?.();
      if (currentUpdatedAt.getTime() > collectionCutoff.getTime()) {
        return null;
      }

      for (const review of connection.nodes) {
        const firstObservation = this.observeOwnedUniqueNode(
          review,
          pullRequestId,
          state.reviewNodes,
          state.reviewOwners,
          'review',
        );
        if (!firstObservation) {
          continue;
        }
        this.incrementNestedNodeCount(state);
        const comments = await this.collectComments(
          review.id,
          pullRequestId,
          collectionCutoff,
          octokit,
          onPage,
          state,
        );
        if (comments === null) {
          return null;
        }
        reviews.push({
          author: this.authorLogin(review.author),
          body: review.body,
          state: review.state,
          comments,
        });
      }

      if (!connection.pageInfo.hasNextPage) {
        return reviews;
      }
      cursor = this.nextCursor(
        connection.pageInfo,
        cursor,
        connection.nodes.length,
        visitedCursors,
        'review',
      );
    }
  }

  private async collectComments(
    reviewId: string,
    pullRequestId: string,
    collectionCutoff: Date,
    octokit: Octokit,
    onPage: (() => Promise<void>) | undefined,
    state: CollectionState,
  ): Promise<ReviewCommentDto[] | null> {
    const comments: ReviewCommentDto[] = [];
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const response = await this.githubProvider.fetchReviewComments(
        reviewId,
        octokit,
        cursor,
      );
      const node = response.node;
      if (!node) {
        throw new GithubPaginationError(
          'review comment',
          'parent node is missing',
        );
      }
      this.assertParentId(node.id, reviewId, 'review comment');
      if (!node.pullRequest) {
        throw new GithubPaginationError(
          'review comment',
          'owning pull request is missing',
        );
      }
      this.assertParentId(node.pullRequest.id, pullRequestId, 'review comment');
      const currentUpdatedAt = this.parseGithubDate(
        node.pullRequest.updatedAt,
        'pull request updatedAt',
      );
      const connection = node.comments;
      this.assertConnection(
        connection?.nodes,
        connection?.pageInfo,
        'review comment',
      );
      await onPage?.();
      if (currentUpdatedAt.getTime() > collectionCutoff.getTime()) {
        return null;
      }

      for (const comment of connection.nodes) {
        const firstObservation = this.observeOwnedUniqueNode(
          comment,
          reviewId,
          state.commentNodes,
          state.commentOwners,
          'review comment',
        );
        if (!firstObservation) {
          continue;
        }
        this.incrementNestedNodeCount(state);
        this.parseGithubDate(comment.createdAt, 'review comment createdAt');
        comments.push({
          author: this.authorLogin(comment.author),
          body: comment.body,
          createdAt: comment.createdAt,
        });
      }

      if (!connection.pageInfo.hasNextPage) {
        return comments;
      }
      cursor = this.nextCursor(
        connection.pageInfo,
        cursor,
        connection.nodes.length,
        visitedCursors,
        'review comment',
      );
    }
  }

  private assertConnection<T>(
    nodes: T[] | undefined,
    pageInfo: PageInfo | undefined,
    connection: string,
  ): asserts nodes is T[] {
    if (
      !Array.isArray(nodes) ||
      pageInfo === undefined ||
      typeof pageInfo.hasNextPage !== 'boolean' ||
      (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== 'string')
    ) {
      throw new GithubPaginationError(connection, 'malformed pageInfo');
    }
  }

  private nextCursor(
    pageInfo: PageInfo,
    currentCursor: string | undefined,
    nodeCount: number,
    visitedCursors: Set<string>,
    connection: string,
  ): string {
    const next = pageInfo.endCursor?.trim();
    if (!next) {
      throw new GithubPaginationError(connection, 'next cursor is empty');
    }
    if (nodeCount === 0) {
      throw new GithubPaginationError(
        connection,
        'an empty page claims to have a next page',
      );
    }
    if (next === currentCursor || visitedCursors.has(next)) {
      throw new GithubPaginationError(connection, 'cursor was repeated');
    }
    visitedCursors.add(next);
    return next;
  }

  private observeOwnedUniqueNode<T extends { id: string }>(
    node: T,
    ownerId: string,
    seenNodes: Map<string, string>,
    owners: Map<string, string>,
    connection: string,
  ): boolean {
    const knownOwner = owners.get(node.id);
    if (knownOwner !== undefined && knownOwner !== ownerId) {
      throw new GithubPaginationError(
        connection,
        'a node appeared under multiple parents',
      );
    }
    const firstObservation = this.observeUniqueNode(
      node,
      seenNodes,
      connection,
    );
    if (firstObservation) {
      owners.set(node.id, ownerId);
    }
    return firstObservation;
  }

  private mergeCollectionState(
    target: CollectionState,
    source: CollectionState,
  ): void {
    this.mergeOwnedNodes(
      target,
      source.reviewNodes,
      source.reviewOwners,
      target.reviewNodes,
      target.reviewOwners,
      'review',
    );
    this.mergeOwnedNodes(
      target,
      source.commentNodes,
      source.commentOwners,
      target.commentNodes,
      target.commentOwners,
      'review comment',
    );
  }

  private mergeOwnedNodes(
    target: CollectionState,
    sourceNodes: Map<string, string>,
    sourceOwners: Map<string, string>,
    targetNodes: Map<string, string>,
    targetOwners: Map<string, string>,
    connection: string,
  ): void {
    for (const [nodeId, serialized] of sourceNodes) {
      const ownerId = sourceOwners.get(nodeId);
      if (ownerId === undefined) {
        throw new GithubPaginationError(connection, 'node owner is missing');
      }
      const knownOwner = targetOwners.get(nodeId);
      if (knownOwner !== undefined && knownOwner !== ownerId) {
        throw new GithubPaginationError(
          connection,
          'a node appeared under multiple parents',
        );
      }
      const previous = targetNodes.get(nodeId);
      if (previous !== undefined) {
        if (previous !== serialized) {
          throw new GithubPaginationError(
            connection,
            'a repeated node contains conflicting data',
          );
        }
        continue;
      }
      targetNodes.set(nodeId, serialized);
      targetOwners.set(nodeId, ownerId);
      this.incrementNestedNodeCount(target);
    }
  }

  private assertParentId(
    actual: unknown,
    expected: string,
    connection: string,
  ): void {
    if (typeof actual !== 'string' || actual.trim().length === 0) {
      throw new GithubPaginationError(connection, 'parent node ID is missing');
    }
    if (actual !== expected) {
      throw new GithubPaginationError(connection, 'parent node does not match');
    }
  }

  private observeUniqueNode<T extends { id: string }>(
    node: T,
    seenNodes: Map<string, string>,
    connection: string,
  ): boolean {
    if (typeof node.id !== 'string' || node.id.trim().length === 0) {
      throw new GithubPaginationError(connection, 'node ID is missing');
    }
    const serialized = JSON.stringify(node);
    const previous = seenNodes.get(node.id);
    if (previous === undefined) {
      seenNodes.set(node.id, serialized);
      return true;
    }
    if (previous !== serialized) {
      throw new GithubPaginationError(
        connection,
        'a repeated node contains conflicting data',
      );
    }
    return false;
  }

  private incrementNestedNodeCount(state: CollectionState): void {
    state.reviewAndCommentCount += 1;
    if (state.reviewAndCommentCount > COLLECTION_LIMITS.reviewAndCommentNodes) {
      throw new InputLimitExceededError(
        'review and comment nodes',
        COLLECTION_LIMITS.reviewAndCommentNodes,
        state.reviewAndCommentCount,
      );
    }
  }

  private parseGithubDate(value: string, field: string): Date {
    if (typeof value !== 'string' || !GITHUB_DATE_PATTERN.test(value)) {
      throw new InvalidGithubDateError(field);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidGithubDateError(field);
    }
    return parsed;
  }

  private authorLogin(author: { login: string } | null): string {
    return author?.login || DELETED_GITHUB_AUTHOR;
  }

  private isValidDate(value: Date): boolean {
    return value instanceof Date && !Number.isNaN(value.getTime());
  }
}
