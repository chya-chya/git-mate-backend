import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { AnalysisController } from './analysis.controller';
import { PublicAnalysisController } from './public-analysis.controller';
import { RefinerService } from './refiner.service';
import { PreprocessorService } from './preprocessor.service';
import { LlmProviderService } from './llm-provider.service';
import { MetricCalculatorService } from './metric-calculator.service';
import { StatService } from './stat.service';
import { AnalysisJobModule } from '../analysis-job/analysis-job.module';

@Module({
  imports: [AnalysisJobModule],
  controllers: [AnalysisController, PublicAnalysisController],
  providers: [
    AnalysisService,
    RefinerService,
    PreprocessorService,
    LlmProviderService,
    MetricCalculatorService,
    StatService,
  ],
  exports: [AnalysisService],
})
export class AnalysisModule {}
