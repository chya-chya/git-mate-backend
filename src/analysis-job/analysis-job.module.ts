import { Module } from '@nestjs/common';
import { AnalysisJobRepository } from './analysis-job.repository';
import { AnalysisJobService } from './analysis-job.service';

@Module({
  providers: [AnalysisJobRepository, AnalysisJobService],
  exports: [AnalysisJobService],
})
export class AnalysisJobModule {}
