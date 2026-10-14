import type { EventBridgeHandler } from 'aws-lambda';
import { reconcileAnalysisJobs } from './analysis-job-reconciler';

export const handler: EventBridgeHandler<
  'Scheduled Event',
  Record<string, never>,
  void
> = async (_event, context): Promise<void> => {
  context.callbackWaitsForEmptyEventLoop = false;
  await reconcileAnalysisJobs();
};
