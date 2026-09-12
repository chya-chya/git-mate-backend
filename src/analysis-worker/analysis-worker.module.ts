import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalysisJobModule } from '../analysis-job/analysis-job.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { CollectionModule } from '../collection/collection.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AnalysisWorkerErrorClassifier } from './analysis-worker-error-classifier';
import { AnalysisWorkerRepository } from './analysis-worker.repository';
import { AnalysisWorkerService } from './analysis-worker.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AnalysisJobModule,
    AnalysisModule,
    CollectionModule,
  ],
  providers: [
    AnalysisWorkerRepository,
    AnalysisWorkerErrorClassifier,
    AnalysisWorkerService,
  ],
})
export class AnalysisWorkerModule {}
