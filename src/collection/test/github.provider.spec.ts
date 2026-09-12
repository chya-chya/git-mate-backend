import { Octokit } from '@octokit/rest';
import { GithubProvider } from '../github.provider';

describe('GithubProvider', () => {
  it('uses the supplied installation-authenticated Octokit instance', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: { pullRequests: { nodes: [] } },
    });
    const provider = new GithubProvider();

    const result = await provider.fetchPullRequests('owner', 'private-repo', {
      graphql,
    } as unknown as Octokit);

    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('pullRequests'),
      {
        owner: 'owner',
        repo: 'private-repo',
        cursor: undefined,
      },
    );
    expect(graphql).toHaveBeenCalledWith(
      expect.not.stringContaining('reviews(first: 50)'),
      expect.anything(),
    );
    expect(result).toEqual({
      repository: { pullRequests: { nodes: [] } },
    });
  });

  it('uses separate review and comment page queries with independent cursors', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({ node: { reviews: { nodes: [] } } })
      .mockResolvedValueOnce({ node: { comments: { nodes: [] } } });
    const provider = new GithubProvider();
    const octokit = { graphql } as unknown as Octokit;

    await provider.fetchPullRequestReviews('PR_1', octokit, 'review-cursor');
    await provider.fetchReviewComments('REVIEW_1', octokit, 'comment-cursor');

    expect(graphql).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('reviews(first: 50, after: $cursor)'),
      { pullRequestId: 'PR_1', cursor: 'review-cursor' },
    );
    expect(graphql).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('comments(first: 50, after: $cursor)'),
      { reviewId: 'REVIEW_1', cursor: 'comment-cursor' },
    );
  });
});
