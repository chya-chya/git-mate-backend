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
    expect(result).toEqual({
      repository: { pullRequests: { nodes: [] } },
    });
  });
});
