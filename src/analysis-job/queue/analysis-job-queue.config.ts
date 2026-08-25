import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const DEFAULT_ANALYSIS_JOB_PUBLISH_MAX_ATTEMPTS = 5;
export const DEFAULT_ANALYSIS_JOB_REPUBLISH_AFTER_SECONDS = 60;
export const DEFAULT_ANALYSIS_JOB_RECONCILE_BATCH_SIZE = 20;

export interface AnalysisJobPublishSettings {
  maxAttempts: number;
  republishAfterSeconds: number;
  reconcileBatchSize: number;
}

export interface AnalysisJobSqsSettings {
  region: string;
  queueUrl: string;
  endpoint?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export class AnalysisJobQueueConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = AnalysisJobQueueConfigurationError.name;
  }
}

@Injectable()
export class AnalysisJobQueueConfig {
  constructor(private readonly configService: ConfigService) {}

  getPublishSettings(): AnalysisJobPublishSettings {
    return {
      maxAttempts: this.positiveInteger(
        'ANALYSIS_JOB_PUBLISH_MAX_ATTEMPTS',
        DEFAULT_ANALYSIS_JOB_PUBLISH_MAX_ATTEMPTS,
        100,
      ),
      republishAfterSeconds: this.positiveInteger(
        'ANALYSIS_JOB_REPUBLISH_AFTER_SECONDS',
        DEFAULT_ANALYSIS_JOB_REPUBLISH_AFTER_SECONDS,
        86_400,
      ),
      reconcileBatchSize: this.positiveInteger(
        'ANALYSIS_JOB_RECONCILE_BATCH_SIZE',
        DEFAULT_ANALYSIS_JOB_RECONCILE_BATCH_SIZE,
        100,
      ),
    };
  }

  getSqsSettings(): AnalysisJobSqsSettings {
    const region = this.required('AWS_REGION');
    const queueUrl = this.validUrl('ANALYSIS_JOB_QUEUE_URL');
    if (!new URL(queueUrl).pathname.endsWith('.fifo')) {
      throw new AnalysisJobQueueConfigurationError(
        'ANALYSIS_JOB_QUEUE_URL must identify a FIFO queue.',
      );
    }

    const endpointValue = this.optional('SQS_ENDPOINT');
    const endpoint = endpointValue
      ? this.validUrl('SQS_ENDPOINT', endpointValue)
      : undefined;
    const accessKeyId = this.optional('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.optional('AWS_SECRET_ACCESS_KEY');
    if (
      (accessKeyId && !secretAccessKey) ||
      (!accessKeyId && secretAccessKey)
    ) {
      throw new AnalysisJobQueueConfigurationError(
        'AWS access key configuration is incomplete.',
      );
    }

    return {
      region,
      queueUrl,
      endpoint,
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
    };
  }

  private positiveInteger(
    name: string,
    defaultValue: number,
    maximum: number,
  ): number {
    const raw = this.optional(name);
    if (raw === undefined) {
      return defaultValue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0 || value > maximum) {
      throw new AnalysisJobQueueConfigurationError(
        `${name} must be a positive integer no greater than ${maximum}.`,
      );
    }
    return value;
  }

  private required(name: string): string {
    const value = this.optional(name);
    if (!value) {
      throw new AnalysisJobQueueConfigurationError(
        `${name} is required to publish analysis jobs.`,
      );
    }
    return value;
  }

  private optional(name: string): string | undefined {
    const value = this.configService.get<string>(name)?.trim();
    return value && value.length > 0 ? value : undefined;
  }

  private validUrl(name: string, configuredValue?: string): string {
    const value = configuredValue ?? this.required(name);
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('unsupported protocol');
      }
      return value;
    } catch {
      throw new AnalysisJobQueueConfigurationError(
        `${name} must be a valid HTTP(S) URL.`,
      );
    }
  }
}
