import { Module } from '@nestjs/common';
import { AnalysisJobRepository } from './analysis-job.repository';
import { AnalysisJobService } from './analysis-job.service';

@Module({
  providers: [AnalysisJobRepository, AnalysisJobService],
  exports: [AnalysisJobRepository, AnalysisJobService],
})
export class AnalysisJobModule {}
