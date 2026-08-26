import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type {
  Context,
  SQSBatchResponse,
  SQSEvent,
  SQSHandler,
} from 'aws-lambda';
import { AnalysisWorkerModule } from './analysis-worker.module';
import { AnalysisWorkerService } from './analysis-worker.service';

type AnalysisWorkerApplicationContext = Pick<INestApplicationContext, 'get'>;
type AnalysisWorkerApplicationFactory =
  () => Promise<AnalysisWorkerApplicationContext>;

const logger = new Logger('AnalysisWorkerHandler');

async function bootstrapApplication(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(AnalysisWorkerModule);
}

export function createAnalysisWorkerHandler(
  applicationFactory: AnalysisWorkerApplicationFactory,
): SQSHandler {
  let applicationPromise: Promise<AnalysisWorkerApplicationContext> | null =
    null;

  const getApplication = () => {
    applicationPromise ??= applicationFactory().catch((error: unknown) => {
      applicationPromise = null;
      throw error;
    });
    return applicationPromise;
  };

  return async (
    event: SQSEvent,
    context: Context,
  ): Promise<SQSBatchResponse> => {
    context.callbackWaitsForEmptyEventLoop = false;
    try {
      const application = await getApplication();
      return application
        .get(AnalysisWorkerService)
        .processBatch(event.Records, context.awsRequestId);
    } catch (error) {
      logger.error({
        event: 'analysis_worker_bootstrap_failed',
        awsRequestId: context.awsRequestId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return {
        batchItemFailures: [
          ...new Set(event.Records.map((record) => record.messageId)),
        ].map((itemIdentifier) => ({ itemIdentifier })),
      };
    }
  };
}

export const handler = createAnalysisWorkerHandler(bootstrapApplication);
