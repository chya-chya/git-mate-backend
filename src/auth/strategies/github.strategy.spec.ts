import { GITHUB_OAUTH_SCOPES } from './github.strategy';

describe('GithubStrategy OAuth scopes', () => {
  it('uses identity and organization scopes without repository access', () => {
    expect(GITHUB_OAUTH_SCOPES).toEqual(['read:user', 'read:org']);
    expect(GITHUB_OAUTH_SCOPES).not.toContain('repo');
    expect(GITHUB_OAUTH_SCOPES).not.toContain('user:email');
  });
});
