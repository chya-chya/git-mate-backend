import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch(BadRequestException)
export class AnalysisJobValidationExceptionFilter implements ExceptionFilter<BadRequestException> {
  catch(_exception: BadRequestException, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(400).json({
      code: 'INVALID_REQUEST',
      message: 'Request validation failed.',
    });
  }
}
