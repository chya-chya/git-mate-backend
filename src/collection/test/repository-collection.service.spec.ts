import { Octokit } from '@octokit/rest';
import { GithubInstallationTokenService } from '../../github-app/github-installation-token.service';
import {
  COLLECTION_LIMITS,
  InputLimitExceededError,
} from '../collection-limits';
import {
  GithubPaginationError,
  InvalidGithubDateError,
} from '../github-errors';
import { GithubProvider } from '../github.provider';
import {
  InvalidRepositoryCollectionInputError,
  RepositoryCollectionService,
} from '../repository-collection.service';
import {
  PullRequestNode,
  ReviewCommentNode,
  ReviewNode,
} from '../types/github-api.types';

describe('RepositoryCollectionService', () => {
  const githubProvider = {
    fetchPullRequests: jest.fn(),
    fetchPullRequestReviews: jest.fn(),
    fetchReviewComments: jest.fn(),
  };
  const installationTokens = { executeForRepository: jest.fn() };
  const service = new RepositoryCollectionService(
    githubProvider as unknown as GithubProvider,
    installationTokens as unknown as GithubInstallationTokenService,
  );
  const sourceCursor = new Date('2026-08-25T00:00:00.000Z');
  const collectionCutoff = new Date('2026-08-26T00:00:00.000Z');

  beforeEach(() => {
    jest.resetAllMocks();
    installationTokens.executeForRepository.mockImplementation(
      async (
        _userId: number,
        _githubRepoId: string,
        operation: (octokit: Octokit) => Promise<unknown>,
      ) => operation({} as Octokit),
    );
    githubProvider.fetchPullRequests.mockResolvedValue(prPage([]));
    githubProvider.fetchPullRequestReviews.mockResolvedValue(reviewPage([]));
    githubProvider.fetchReviewComments.mockResolvedValue(commentPage([]));
  });

  it('collects every PR cursor page and passes each previous endCursor', async () => {
    githubProvider.fetchPullRequests
      .mockResolvedValueOnce(
        prPage([pullRequest('PR_1', 1)], true, 'pr-cursor-1'),
      )
      .mockResolvedValueOnce(prPage([pullRequest('PR_2', 2)]));

    const result = await collect();

    expect(result.pullRequests.map(({ number }) => number)).toEqual([1, 2]);
    expect(githubProvider.fetchPullRequests).toHaveBeenNthCalledWith(
      1,
      'owner',
      'repo',
      expect.anything(),
      undefined,
    );
    expect(githubProvider.fetchPullRequests).toHaveBeenNthCalledWith(
      2,
      'owner',
      'repo',
      expect.anything(),
      'pr-cursor-1',
    );
  });

  it('uses sourceCursor < updatedAt <= cutoff and does not stop on a too-new first page', async () => {
    githubProvider.fetchPullRequests
      .mockResolvedValueOnce(
        prPage(
          [pullRequest('TOO_NEW', 1, '2026-08-26T00:00:00.001Z')],
          true,
          'next',
        ),
      )
      .mockResolvedValueOnce(
        prPage(
          [
            pullRequest('AT_CUTOFF', 2, '2026-08-26T00:00:00.000Z'),
            pullRequest('AFTER_SOURCE', 3, '2026-08-25T00:00:00.001Z'),
            pullRequest('AT_SOURCE', 4, '2026-08-25T00:00:00.000Z'),
          ],
          true,
          'unused',
        ),
      );

    const result = await collect({ sourceCursor });

    expect(result.pullRequests.map(({ number }) => number)).toEqual([2, 3]);
    expect(githubProvider.fetchPullRequests).toHaveBeenCalledTimes(2);
  });

  it('collects post-cutoff activity only in the next fixed window', async () => {
    const changedLater = pullRequest('PR_LATER', 9, '2026-08-26T00:00:00.001Z');
    githubProvider.fetchPullRequests.mockResolvedValue(prPage([changedLater]));

    await expect(collect()).resolves.toMatchObject({ pullRequests: [] });
    await expect(
      collect({
        sourceCursor: collectionCutoff,
        collectionCutoff: new Date('2026-08-27T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ pullRequests: [{ number: 9 }] });
  });

  it('restarts the same collection window from scratch after a 401 refresh', async () => {
    const firstOctokit = { attempt: 1 } as unknown as Octokit;
    const secondOctokit = { attempt: 2 } as unknown as Octokit;
    installationTokens.executeForRepository.mockImplementation(
      async (
        _userId: number,
        _repoId: string,
        operation: (octokit: Octokit) => Promise<unknown>,
      ) => {
        try {
          return await operation(firstOctokit);
        } catch (error) {
          if ((error as { status?: number }).status !== 401) {
            throw error;
          }
          return await operation(secondOctokit);
        }
      },
    );
    githubProvider.fetchPullRequests.mockImplementation(
      (_owner, _repo, octokit: Octokit, cursor?: string) => {
        if (cursor === undefined) {
          return Promise.resolve(
            prPage([pullRequest('PR_1', 1)], true, 'next'),
          );
        }
        if (octokit === firstOctokit) {
          return Promise.reject(
            Object.assign(new Error('unauthorized'), { status: 401 }),
          );
        }
        return Promise.resolve(prPage([pullRequest('PR_2', 2)]));
      },
    );

    const result = await collect({ sourceCursor });

    expect(result.pullRequests.map(({ number }) => number)).toEqual([1, 2]);
    expect(githubProvider.fetchPullRequests).toHaveBeenCalledTimes(4);
  });

  it('collects 51 reviews and 51 comments through independent cursors', async () => {
    githubProvider.fetchPullRequests.mockResolvedValue(
      prPage([pullRequest('PR_1', 1)]),
    );
    const reviews = Array.from({ length: 51 }, (_, index) =>
      review(`REVIEW_${index + 1}`),
    );
    githubProvider.fetchPullRequestReviews
      .mockResolvedValueOnce(reviewPage(reviews.slice(0, 50), true, 'r-50'))
      .mockResolvedValueOnce(reviewPage(reviews.slice(50)));
    const comments = Array.from({ length: 51 }, (_, index) =>
      comment(`COMMENT_${index + 1}`),
    );
    githubProvider.fetchReviewComments.mockImplementation(
      (reviewId: string, _octokit: Octokit, cursor?: string) => {
        if (reviewId !== 'REVIEW_1') {
          return Promise.resolve(commentPage([]));
        }
        return Promise.resolve(
          cursor === undefined
            ? commentPage(comments.slice(0, 50), true, 'c-50')
            : commentPage(comments.slice(50)),
        );
      },
    );

    const result = await collect();

    expect(result.pullRequests[0].reviews).toHaveLength(51);
    expect(result.pullRequests[0].reviews[0].comments).toHaveLength(51);
    expect(githubProvider.fetchPullRequestReviews).toHaveBeenNthCalledWith(
      2,
      'PR_1',
      expect.anything(),
      'r-50',
    );
    expect(githubProvider.fetchReviewComments).toHaveBeenCalledWith(
      'REVIEW_1',
      expect.anything(),
      'c-50',
    );
  });

  it('does not share review or comment cursors across parent nodes', async () => {
    githubProvider.fetchPullRequests.mockResolvedValue(
      prPage([pullRequest('PR_1', 1), pullRequest('PR_2', 2)]),
    );
    githubProvider.fetchPullRequestReviews.mockImplementation(
      (pullRequestId: string, _octokit: Octokit, cursor?: string) =>
        Promise.resolve(
          cursor === undefined
            ? reviewPage(
                [review(`${pullRequestId}_REVIEW_1`)],
                true,
                `${pullRequestId}_CURSOR`,
              )
            : reviewPage([review(`${pullRequestId}_REVIEW_2`)]),
        ),
    );
    githubProvider.fetchReviewComments.mockImplementation(
      (reviewId: string, _octokit: Octokit, cursor?: string) =>
        Promise.resolve(
          cursor === undefined
            ? commentPage(
                [comment(`${reviewId}_COMMENT_1`)],
                true,
                `${reviewId}_CURSOR`,
              )
            : commentPage([comment(`${reviewId}_COMMENT_2`)]),
        ),
    );

    await collect();

    expect(githubProvider.fetchPullRequestReviews).toHaveBeenCalledWith(
      'PR_2',
      expect.anything(),
      undefined,
    );
    expect(githubProvider.fetchReviewComments).toHaveBeenCalledWith(
      'PR_2_REVIEW_1',
      expect.anything(),
      undefined,
    );
  });

  it('deduplicates identical page-boundary nodes in first-observation order', async () => {
    const duplicate = pullRequest('PR_2', 2);
    githubProvider.fetchPullRequests
      .mockResolvedValueOnce(
        prPage([pullRequest('PR_1', 1), duplicate], true, 'boundary'),
      )
      .mockResolvedValueOnce(prPage([duplicate, pullRequest('PR_3', 3)]));

    const result = await collect();

    expect(result.pullRequests.map(({ number }) => number)).toEqual([1, 2, 3]);
  });

  it('represents deleted authors without confusing them with the target user', async () => {
    const pr = pullRequest('PR_1', 1);
    pr.author = null;
    githubProvider.fetchPullRequests.mockResolvedValue(prPage([pr]));
    const deletedReview = review('REVIEW_1');
    deletedReview.author = null;
    githubProvider.fetchPullRequestReviews.mockResolvedValue(
      reviewPage([deletedReview]),
    );
    const deletedComment = comment('COMMENT_1');
    deletedComment.author = null;
    githubProvider.fetchReviewComments.mockResolvedValue(
      commentPage([deletedComment]),
    );

    const result = await collect();

    expect(result.pullRequests[0]).toMatchObject({
      author: '[deleted]',
      reviews: [{ author: '[deleted]', comments: [{ author: '[deleted]' }] }],
    });
  });

  it.each([
    ['null cursor', prPage([pullRequest('PR_1', 1)], true, null)],
    ['empty cursor', prPage([pullRequest('PR_1', 1)], true, ' ')],
    ['empty advancing page', prPage([], true, 'next')],
  ])('fails finitely for %s', async (_caseName, page) => {
    githubProvider.fetchPullRequests.mockResolvedValue(page);

    await expect(collect()).rejects.toBeInstanceOf(GithubPaginationError);
    expect(githubProvider.fetchPullRequests).toHaveBeenCalledTimes(1);
  });

  it('fails when a cursor repeats or a duplicate node conflicts', async () => {
    githubProvider.fetchPullRequests
      .mockResolvedValueOnce(prPage([pullRequest('PR_1', 1)], true, 'repeated'))
      .mockResolvedValueOnce(
        prPage([pullRequest('PR_2', 2)], true, 'repeated'),
      );
    await expect(collect()).rejects.toBeInstanceOf(GithubPaginationError);

    jest.resetAllMocks();
    installationTokens.executeForRepository.mockImplementation(
      (
        _userId: number,
        _repoId: string,
        operation: (octokit: Octokit) => Promise<unknown>,
      ) => operation({} as Octokit),
    );
    githubProvider.fetchPullRequestReviews.mockResolvedValue(reviewPage([]));
    githubProvider.fetchPullRequests
      .mockResolvedValueOnce(prPage([pullRequest('PR_1', 1)], true, 'next'))
      .mockResolvedValueOnce(
        prPage([{ ...pullRequest('PR_1', 1), title: 'Conflicting' }]),
      );
    await expect(collect()).rejects.toBeInstanceOf(GithubPaginationError);
  });

  it('fails with a typed error for an invalid GitHub date', async () => {
    githubProvider.fetchPullRequests.mockResolvedValue(
      prPage([pullRequest('PR_1', 1, 'not-a-date')]),
    );

    await expect(collect()).rejects.toBeInstanceOf(InvalidGithubDateError);
  });

  it.each([
    [COLLECTION_LIMITS.changedPullRequests, false],
    [COLLECTION_LIMITS.changedPullRequests + 1, true],
  ])('enforces the changed PR limit at %i nodes', async (count, fails) => {
    const nodes = Array.from({ length: count }, (_, index) =>
      pullRequest(`PR_${index}`, index),
    );
    githubProvider.fetchPullRequests
      .mockResolvedValueOnce(
        prPage(
          nodes.slice(0, COLLECTION_LIMITS.changedPullRequests),
          fails,
          fails ? 'check-101' : null,
        ),
      )
      .mockResolvedValueOnce(
        prPage(nodes.slice(COLLECTION_LIMITS.changedPullRequests)),
      );

    const operation = collect();
    if (fails) {
      await expect(operation).rejects.toMatchObject({
        code: 'INPUT_LIMIT_EXCEEDED',
        limitKind: 'changed pull requests',
      });
      expect(githubProvider.fetchPullRequests).toHaveBeenCalledTimes(2);
    } else {
      await expect(operation).resolves.toHaveProperty(
        'pullRequests.length',
        count,
      );
    }
  });

  it.each([
    [COLLECTION_LIMITS.reviewAndCommentNodes, false],
    [COLLECTION_LIMITS.reviewAndCommentNodes + 1, true],
  ])(
    'enforces the combined review/comment limit at %i nodes',
    async (count, fails) => {
      githubProvider.fetchPullRequests.mockResolvedValue(
        prPage([pullRequest('PR_1', 1)]),
      );
      githubProvider.fetchPullRequestReviews.mockResolvedValue(
        reviewPage([review('REVIEW_1')]),
      );
      githubProvider.fetchReviewComments.mockResolvedValue(
        commentPage(
          Array.from({ length: count - 1 }, (_, index) =>
            comment(`COMMENT_${index}`),
          ),
        ),
      );

      const operation = collect();
      if (fails) {
        await expect(operation).rejects.toBeInstanceOf(InputLimitExceededError);
      } else {
        await expect(operation).resolves.toHaveProperty(
          'pullRequests.0.reviews.0.comments.length',
          count - 1,
        );
      }
    },
  );

  it('stops all subsequent GitHub calls when the page heartbeat loses its lease', async () => {
    const staleLease = new Error('stale lease');
    const onPage = jest.fn().mockRejectedValue(staleLease);
    githubProvider.fetchPullRequests.mockResolvedValue(
      prPage([pullRequest('PR_1', 1)], true, 'next'),
    );

    await expect(collect({ onPage })).rejects.toBe(staleLease);
    expect(githubProvider.fetchPullRequests).toHaveBeenCalledTimes(1);
    expect(githubProvider.fetchPullRequestReviews).not.toHaveBeenCalled();
  });

  it('rejects malformed repository metadata before GitHub calls', async () => {
    await expect(collect({ fullName: 'malformed' })).rejects.toBeInstanceOf(
      InvalidRepositoryCollectionInputError,
    );
    expect(installationTokens.executeForRepository).not.toHaveBeenCalled();
  });

  function collect(
    overrides: Partial<
      Parameters<RepositoryCollectionService['collect']>[0]
    > = {},
  ) {
    return service.collect({
      userId: 7,
      githubRepoId: '11',
      fullName: 'owner/repo',
      targetUser: 'developer',
      collectionCutoff,
      ...overrides,
    });
  }

  function pullRequest(
    id: string,
    number: number,
    updatedAt = '2026-08-25T01:00:00.000Z',
  ): PullRequestNode {
    return {
      id,
      number,
      title: `PR ${number}`,
      body: 'Body',
      state: 'OPEN',
      permalink: `https://github.com/owner/repo/pull/${number}`,
      author: { login: 'author' },
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt,
    };
  }

  function review(id: string): ReviewNode {
    return {
      id,
      author: { login: 'reviewer' },
      body: 'Substantive review',
      state: 'APPROVED',
    };
  }

  function comment(id: string): ReviewCommentNode {
    return {
      id,
      author: { login: 'reviewer' },
      body: 'Substantive comment',
      createdAt: '2026-08-25T01:01:00.000Z',
    };
  }

  function prPage(
    nodes: PullRequestNode[],
    hasNextPage = false,
    endCursor: string | null = null,
  ) {
    return {
      repository: {
        pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    };
  }

  function reviewPage(
    nodes: ReviewNode[],
    hasNextPage = false,
    endCursor: string | null = null,
  ) {
    return {
      node: { reviews: { nodes, pageInfo: { hasNextPage, endCursor } } },
    };
  }

  function commentPage(
    nodes: ReviewCommentNode[],
    hasNextPage = false,
    endCursor: string | null = null,
  ) {
    return {
      node: { comments: { nodes, pageInfo: { hasNextPage, endCursor } } },
    };
  }
});
