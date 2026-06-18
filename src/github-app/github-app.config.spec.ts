import { ConfigService } from '@nestjs/config';
import { GithubAppConfig } from './github-app.config';

describe('GithubAppConfig', () => {
  it('fails fast when required GitHub App configuration is missing', () => {
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    };

    expect(
      () => new GithubAppConfig(configService as unknown as ConfigService),
    ).toThrow('GITHUB_APP_ID is required');
  });
});
