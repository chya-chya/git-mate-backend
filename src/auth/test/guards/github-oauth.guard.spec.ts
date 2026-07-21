import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { GithubOAuthGuard } from '../../guards/github-oauth.guard';

describe('GithubOAuthGuard', () => {
  const jwtService = {
    verify: jest.fn(),
    sign: jest.fn(),
  };
  const configService = {
    get: jest.fn(),
  };

  let guard: GithubOAuthGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    configService.get.mockReturnValue('jwt-secret');
    guard = new GithubOAuthGuard(
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
    );
  });

  it('uses the normal GitHub OAuth flow when mode is not reauthorize', () => {
    const context = createContext({
      query: {},
      headers: {},
    });

    expect(guard.getAuthenticateOptions(context)).toEqual({});
    expect(jwtService.verify).not.toHaveBeenCalled();
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it('adds signed state for GitHub OAuth reauthorization', () => {
    jwtService.verify.mockReturnValue({ sub: 7 });
    jwtService.sign.mockReturnValue('signed-state');
    const context = createContext({
      query: { mode: 'reauthorize' },
      headers: { authorization: 'Bearer access-token' },
    });

    expect(guard.getAuthenticateOptions(context)).toEqual({
      state: 'signed-state',
    });
    expect(jwtService.verify).toHaveBeenCalledWith('access-token', {
      secret: 'jwt-secret',
    });
    expect(jwtService.sign).toHaveBeenCalledWith(
      {
        sub: 7,
        purpose: 'github-oauth-reauthorize',
      },
      {
        secret: 'jwt-secret',
        expiresIn: '10m',
      },
    );
  });

  it('falls back to normal OAuth when reauthorization is opened directly in a browser', () => {
    const context = createContext({
      query: { mode: 'reauthorize' },
      headers: {},
    });

    expect(guard.getAuthenticateOptions(context)).toEqual({});
  });
});

function createContext(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}
