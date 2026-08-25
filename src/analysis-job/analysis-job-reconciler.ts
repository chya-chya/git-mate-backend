import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AnalysisJobReconcilerService } from './analysis-job-reconciler.service';

export async function reconcileAnalysisJobs(): Promise<void> {
  const application = await NestFactory.createApplicationContext(AppModule);
  try {
    await application.get(AnalysisJobReconcilerService).runOnce();
  } finally {
    await application.close();
  }
}

if (require.main === module) {
  void reconcileAnalysisJobs().catch((error: unknown) => {
    const logger = new Logger('AnalysisJobReconciler');
    logger.error(
      `Analysis job reconciliation failed errorType=${error instanceof Error ? error.name : 'UnknownError'}`,
    );
    process.exitCode = 1;
  });
}
