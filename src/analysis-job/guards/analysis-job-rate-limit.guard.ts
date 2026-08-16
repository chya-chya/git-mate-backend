import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Request, Response } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id?: number };
}

const RATE_LIMIT = 5;
const RATE_LIMIT_TTL_MS = 60_000;
const THROTTLER_NAME = 'analysis-job-create';

@Injectable()
export class AnalysisJobRateLimitGuard implements CanActivate {
  constructor(
    @Inject(ThrottlerStorage)
    private readonly storage: ThrottlerStorage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const userId = request.user?.id;
    if (!Number.isInteger(userId) || (userId ?? 0) <= 0) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Authentication is required.',
      });
    }

    const record = await this.storage.increment(
      `${THROTTLER_NAME}:user:${userId}`,
      RATE_LIMIT_TTL_MS,
      RATE_LIMIT,
      RATE_LIMIT_TTL_MS,
      THROTTLER_NAME,
    );
    response.setHeader('X-RateLimit-Limit-Analysis-Job', RATE_LIMIT);
    response.setHeader(
      'X-RateLimit-Remaining-Analysis-Job',
      Math.max(0, RATE_LIMIT - record.totalHits),
    );
    response.setHeader('X-RateLimit-Reset-Analysis-Job', record.timeToExpire);

    if (record.isBlocked) {
      response.setHeader('Retry-After', record.timeToBlockExpire);
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Analysis job creation rate limit exceeded.',
        },
        429,
      );
    }
    return true;
  }
}
