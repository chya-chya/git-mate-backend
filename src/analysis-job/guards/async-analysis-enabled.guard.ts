import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AsyncAnalysisEnabledGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(): boolean {
    if (this.configService.get<string>('ASYNC_ANALYSIS_ENABLED') === 'true') {
      return true;
    }
    throw new ServiceUnavailableException({
      code: 'ASYNC_ANALYSIS_DISABLED',
      message: 'Asynchronous analysis is disabled.',
    });
  }
}
