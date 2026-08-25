import { Injectable, Logger } from '@nestjs/common';
import { AnalysisJobPublishRepository } from './analysis-job-publish.repository';
import {
  AnalysisJobPublishOutcome,
  AnalysisJobPublisherService,
} from './analysis-job-publisher.service';
import { AnalysisJobQueueConfig } from './queue/analysis-job-queue.config';

export interface AnalysisJobReconcileSummary {
  scanned: number;
  published: number;
  deferred: number;
  failed: number;
}

@Injectable()
export class AnalysisJobReconcilerService {
  private readonly logger = new Logger(AnalysisJobReconcilerService.name);

  constructor(
    private readonly repository: AnalysisJobPublishRepository,
    private readonly publisher: AnalysisJobPublisherService,
    private readonly config: AnalysisJobQueueConfig,
  ) {}

  async runOnce(now = new Date()): Promise<AnalysisJobReconcileSummary> {
    const settings = this.config.getPublishSettings();
    const jobs = await this.repository.findDue(
      now,
      settings.republishAfterSeconds,
      settings.maxAttempts,
      settings.reconcileBatchSize,
    );
    const summary: AnalysisJobReconcileSummary = {
      scanned: jobs.length,
      published: 0,
      deferred: 0,
      failed: 0,
    };

    for (const job of jobs) {
      try {
        const outcome = await this.publisher.publish(job, {
          allowRepublish: true,
          now,
        });
        if (outcome === AnalysisJobPublishOutcome.PUBLISHED) {
          summary.published += 1;
        } else if (outcome === AnalysisJobPublishOutcome.FAILED) {
          summary.failed += 1;
        } else {
          summary.deferred += 1;
        }
      } catch {
        summary.deferred += 1;
        this.logger.error(
          `Analysis job reconciliation item failed jobId=${job.id}`,
        );
      }
    }

    this.logger.log(
      `Analysis job reconciliation completed scanned=${summary.scanned} published=${summary.published} deferred=${summary.deferred} failed=${summary.failed}`,
    );
    return summary;
  }
}
