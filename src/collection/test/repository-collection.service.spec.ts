import { Octokit } from '@octokit/rest';
import { GithubInstallationTokenService } from '../../github-app/github-installation-token.service';
import { GithubProvider } from '../github.provider';
import {
  InvalidRepositoryCollectionInputError,
  RepositoryCollectionService,
} from '../repository-collection.service';

describe('RepositoryCollectionService', () => {
  const githubProvider = { fetchPullRequests: jest.fn() };
  const installationTokens = { executeForRepository: jest.fn() };
  const service = new RepositoryCollectionService(
    githubProvider as unknown as GithubProvider,
    installationTokens as unknown as GithubInstallationTokenService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    installationTokens.executeForRepository.mockImplementation(
      async (
        _userId: number,
        _githubRepoId: string,
        operation: (octokit: Octokit) => Promise<unknown>,
      ) => operation({} as Octokit),
    );
  });

  it('collects with the supplied source cursor and transforms GitHub data', async () => {
    const sourceCursor = new Date('2026-08-25T00:00:00.000Z');
    githubProvider.fetchPullRequests.mockResolvedValue({
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 41,
              title: 'Already collected',
              body: 'Old body',
              author: { login: 'author' },
              updatedAt: '2026-08-24T23:59:59.000Z',
              permalink: 'https://github.com/owner/repo/pull/41',
              reviews: { nodes: [] },
            },
            {
              number: 42,
              title: 'Worker',
              body: 'Body',
              author: { login: 'author' },
              updatedAt: '2026-08-25T01:00:00.000Z',
              permalink: 'https://github.com/owner/repo/pull/42',
              reviews: {
                nodes: [
                  {
                    author: { login: 'reviewer' },
                    body: 'Review',
                    state: 'APPROVED',
                    comments: {
                      nodes: [
                        {
                          author: { login: 'reviewer' },
                          body: 'Comment',
                          createdAt: '2026-08-25T01:01:00.000Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    await expect(
      service.collect({
        userId: 7,
        githubRepoId: '11',
        fullName: 'owner/repo',
        targetUser: 'developer',
        sourceCursor,
      }),
    ).resolves.toEqual({
      githubRepoId: '11',
      owner: 'owner',
      repo: 'repo',
      targetUser: 'developer',
      pullRequests: [
        {
          number: 42,
          title: 'Worker',
          body: 'Body',
          author: 'author',
          updatedAt: '2026-08-25T01:00:00.000Z',
          permalink: 'https://github.com/owner/repo/pull/42',
          reviews: [
            {
              author: 'reviewer',
              body: 'Review',
              state: 'APPROVED',
              comments: [
                {
                  author: 'reviewer',
                  body: 'Comment',
                  createdAt: '2026-08-25T01:01:00.000Z',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(githubProvider.fetchPullRequests).toHaveBeenCalledWith(
      'owner',
      'repo',
      expect.anything(),
      sourceCursor,
    );
  });

  it('rejects malformed database repository metadata before GitHub calls', async () => {
    await expect(
      service.collect({
        userId: 7,
        githubRepoId: '11',
        fullName: 'malformed',
        targetUser: 'developer',
      }),
    ).rejects.toBeInstanceOf(InvalidRepositoryCollectionInputError);

    expect(installationTokens.executeForRepository).not.toHaveBeenCalled();
    expect(githubProvider.fetchPullRequests).not.toHaveBeenCalled();
  });
});
