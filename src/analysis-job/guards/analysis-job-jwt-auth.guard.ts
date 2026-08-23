import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class AnalysisJobJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser>(error: Error | null, user: TUser | false | null): TUser {
    if (error) {
      throw error;
    }
    if (!user) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Authentication is required.',
      });
    }
    return user;
  }
}
