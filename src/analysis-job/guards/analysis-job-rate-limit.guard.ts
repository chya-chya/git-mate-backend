import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ANALYSIS_JOB_CREATION_RATE_LIMIT,
  AnalysisJobApiRepository,
  AnalysisJobCreationRateLimitStatus,
} from '../analysis-job-api.repository';

interface AuthenticatedRequest extends Request {
  user?: { id?: number };
}

@Injectable()
export class AnalysisJobRateLimitGuard implements CanActivate {
  constructor(private readonly repository: AnalysisJobApiRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const userId = request.user?.id;
    if (
      typeof userId !== 'number' ||
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Authentication is required.',
      });
    }

    let record: AnalysisJobCreationRateLimitStatus;
    try {
      record = await this.repository.getCreationRateLimitStatus(userId);
    } catch {
      throw new ServiceUnavailableException({
        code: 'JOB_ACCEPTANCE_UNAVAILABLE',
        message: 'Analysis job acceptance is temporarily unavailable.',
      });
    }

    response.setHeader(
      'X-RateLimit-Limit-Analysis-Job',
      ANALYSIS_JOB_CREATION_RATE_LIMIT,
    );
    response.setHeader('X-RateLimit-Remaining-Analysis-Job', record.remaining);
    response.setHeader(
      'X-RateLimit-Reset-Analysis-Job',
      record.retryAfterSeconds,
    );

    if (record.isBlocked) {
      response.setHeader('Retry-After', record.retryAfterSeconds);
    }

    // The service enforces the limit transactionally after resolving an
    // existing idempotency key. Blocking here would reject safe replays.
    return true;
  }
}
