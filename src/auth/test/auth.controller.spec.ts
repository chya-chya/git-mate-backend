import type { Request, Response } from 'express';
import { AuthController } from '.././auth.controller';
import { AuthService } from '.././auth.service';

describe('AuthController', () => {
  const authService = {
    completeGithubOAuth: jest.fn(),
    createGithubReauthorizationUrl: jest.fn(),
    login: jest.fn(),
  };

  const originalFrontendUrl = process.env.FRONTEND_URL;
  let controller: AuthController;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FRONTEND_URL = 'http://localhost:3001';
    controller = new AuthController(authService as unknown as AuthService);
  });

  afterAll(() => {
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  it('preserves the frontend OAuth callback query contract', async () => {
    const oauthUser = {
      githubId: '159997395',
      username: 'chya-chya',
      avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
      accessToken: 'reduced-scope-oauth-token',
    };
    const savedUser = {
      id: 7,
      githubId: oauthUser.githubId,
      username: oauthUser.username,
    };
    const redirect = jest.fn();
    authService.completeGithubOAuth.mockResolvedValue(savedUser);
    authService.login.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });

    await controller.githubAuthRedirect(
      { user: oauthUser } as unknown as Request,
      { redirect } as unknown as Response,
    );

    expect(authService.completeGithubOAuth).toHaveBeenCalledWith(
      oauthUser,
      undefined,
    );
    expect(authService.login).toHaveBeenCalledWith(savedUser);
    expect(redirect).toHaveBeenCalledWith(
      'http://localhost:3001/auth/callback?access_token=access-token&refresh_token=refresh-token&username=chya-chya',
    );
  });

  it('passes GitHub OAuth state to support reauthorization callbacks', async () => {
    const oauthUser = {
      githubId: '159997395',
      username: 'chya-chya',
      avatarUrl: 'https://avatars.githubusercontent.com/u/159997395',
      accessToken: 'reauthorized-oauth-token',
    };
    const savedUser = {
      id: 7,
      githubId: oauthUser.githubId,
      username: oauthUser.username,
    };
    const redirect = jest.fn();
    authService.completeGithubOAuth.mockResolvedValue(savedUser);
    authService.login.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });

    await controller.githubAuthRedirect(
      {
        user: oauthUser,
        query: { state: 'signed-state' },
      } as unknown as Request,
      { redirect } as unknown as Response,
    );

    expect(authService.completeGithubOAuth).toHaveBeenCalledWith(
      oauthUser,
      'signed-state',
    );
    expect(redirect).toHaveBeenCalledWith(
      'http://localhost:3001/auth/callback?access_token=access-token&refresh_token=refresh-token&username=chya-chya',
    );
  });

  it('returns a reauthorization URL for the authenticated user', async () => {
    authService.createGithubReauthorizationUrl.mockResolvedValue({
      url: 'https://github.com/login/oauth/authorize?state=signed-state',
    });

    await expect(
      controller.getGithubReauthorizeUrl({
        user: { id: 7, username: 'chya-chya' },
      } as unknown as Request),
    ).resolves.toEqual({
      url: 'https://github.com/login/oauth/authorize?state=signed-state',
    });

    expect(authService.createGithubReauthorizationUrl).toHaveBeenCalledWith(7);
  });
});
