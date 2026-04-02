import { Test, TestingModule } from '@nestjs/testing';
import { GithubProvider } from './github.provider';

// Mock the whole module
jest.mock('@octokit/rest', () => {
  return {
    Octokit: jest.fn().mockImplementation(() => {
      return {
        graphql: jest.fn().mockResolvedValue({
          repository: { pullRequests: { nodes: [] } },
        }),
      };
    }),
  };
});

describe('GithubProvider', () => {
  let provider: GithubProvider;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GithubProvider],
    }).compile();

    provider = module.get<GithubProvider>(GithubProvider);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });

  describe('fetchPullRequests', () => {
    it('should call octokit.graphql and return data', async () => {
      const owner = 'test-owner';
      const repo = 'test-repo';
      const token = 'test-token';

      const result = await provider.fetchPullRequests(owner, repo, token);
      
      expect(result).toBeDefined();
      expect(result.repository.pullRequests.nodes).toEqual([]);
    });
  });
});
