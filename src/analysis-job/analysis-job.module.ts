import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalysisJobApiRepository } from './analysis-job-api.repository';
import { AnalysisJobApiService } from './analysis-job-api.service';
import { AnalysisJobController } from './analysis-job.controller';
import { AnalysisJobRepository } from './analysis-job.repository';
import { AnalysisJobResponseMapper } from './analysis-job-response.mapper';
import { AnalysisJobService } from './analysis-job.service';
import { AnalysisJobValidationExceptionFilter } from './filters/analysis-job-validation-exception.filter';
import { AnalysisJobJwtAuthGuard } from './guards/analysis-job-jwt-auth.guard';
import { AnalysisJobRateLimitGuard } from './guards/analysis-job-rate-limit.guard';
import { AsyncAnalysisEnabledGuard } from './guards/async-analysis-enabled.guard';
import { AnalysisJobUuidPipe } from './pipes/analysis-job-uuid.pipe';
import { IdempotencyKeyPipe } from './pipes/idempotency-key.pipe';

@Module({
  imports: [ConfigModule],
  controllers: [AnalysisJobController],
  providers: [
    AnalysisJobRepository,
    AnalysisJobService,
    AnalysisJobApiRepository,
    AnalysisJobApiService,
    AnalysisJobResponseMapper,
    AnalysisJobJwtAuthGuard,
    AnalysisJobRateLimitGuard,
    AsyncAnalysisEnabledGuard,
    AnalysisJobUuidPipe,
    IdempotencyKeyPipe,
    AnalysisJobValidationExceptionFilter,
  ],
  exports: [AnalysisJobService],
})
export class AnalysisJobModule {}
