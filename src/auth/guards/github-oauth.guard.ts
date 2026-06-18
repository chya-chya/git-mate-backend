import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export interface GithubOAuthStatePayload {
  sub: number;
  purpose: 'github-oauth-reauthorize';
}

@Injectable()
export class GithubOAuthGuard extends AuthGuard('github') {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  getAuthenticateOptions(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();

    if (request.query.mode !== 'reauthorize') {
      return {};
    }

    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      throw new Error(
        'JWT_SECRET is not configured! GitHub reauthorization cannot be initialized safely.',
      );
    }

    const accessToken = this.extractBearerToken(request);
    if (!accessToken) {
      throw new UnauthorizedException(
        'GitHub OAuth reauthorization requires an access token',
      );
    }

    let payload: { sub: number };
    try {
      payload = this.jwtService.verify<{ sub: number }>(accessToken, {
        secret: jwtSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }

    const state = this.jwtService.sign(
      {
        sub: payload.sub,
        purpose: 'github-oauth-reauthorize',
      } satisfies GithubOAuthStatePayload,
      {
        secret: jwtSecret,
        expiresIn: '10m',
      },
    );

    return { state };
  }

  private extractBearerToken(request: Request): string | null {
    const authorization = request.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      return null;
    }

    return authorization.slice('Bearer '.length).trim() || null;
  }
}
