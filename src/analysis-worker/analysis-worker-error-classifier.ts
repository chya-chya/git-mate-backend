import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from 'openai';
import { PostBillingAnalysisPersistenceError } from '../analysis/analysis.service';
import { UnsupportedAnalysisExecutionVersionError } from '../analysis/analysis-execution-version';
import { LlmProviderConfigurationError } from '../analysis/llm-provider.service';
import { StaleAnalysisJobTransitionError } from '../analysis-job/analysis-job.service';
import { InvalidRepositoryCollectionInputError } from '../collection/repository-collection.service';
import {
  BilledAnalysisJobRequiresReconciliationError,
  StaleAnalysisWorkerLeaseError,
} from './analysis-worker.repository';

const RETRYABLE_PRISMA_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2034',
]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

export enum AnalysisWorkerFailureCode {
  ANALYSIS_FAILED = 'ANALYSIS_FAILED',
  DATABASE_TEMPORARY_FAILURE = 'DATABASE_TEMPORARY_FAILURE',
  GITHUB_TEMPORARY_FAILURE = 'GITHUB_TEMPORARY_FAILURE',
  INVALID_MESSAGE = 'INVALID_MESSAGE',
  PROVIDER_CONFIGURATION_ERROR = 'PROVIDER_CONFIGURATION_ERROR',
  PROVIDER_RECONCILIATION_REQUIRED = 'PROVIDER_RECONCILIATION_REQUIRED',
  PROVIDER_REQUEST_INVALID = 'PROVIDER_REQUEST_INVALID',
  PROVIDER_TEMPORARY_FAILURE = 'PROVIDER_TEMPORARY_FAILURE',
  REPOSITORY_UNAVAILABLE = 'REPOSITORY_UNAVAILABLE',
  UNSUPPORTED_ANALYSIS_VERSION = 'UNSUPPORTED_ANALYSIS_VERSION',
  WORKER_LEASE_UNAVAILABLE = 'WORKER_LEASE_UNAVAILABLE',
}

export interface AnalysisWorkerErrorClassification {
  code: AnalysisWorkerFailureCode;
  message: string;
  retryable: boolean;
}

@Injectable()
export class AnalysisWorkerErrorClassifier {
  classify(error: unknown): AnalysisWorkerErrorClassification {
    if (
      error instanceof StaleAnalysisWorkerLeaseError ||
      error instanceof StaleAnalysisJobTransitionError
    ) {
      return this.retryable(
        AnalysisWorkerFailureCode.WORKER_LEASE_UNAVAILABLE,
        'The analysis job lease is unavailable.',
      );
    }

    if (error instanceof BilledAnalysisJobRequiresReconciliationError) {
      return this.permanent(
        AnalysisWorkerFailureCode.PROVIDER_RECONCILIATION_REQUIRED,
        'The provider charge requires reconciliation.',
      );
    }

    if (error instanceof PostBillingAnalysisPersistenceError) {
      return this.retryable(
        AnalysisWorkerFailureCode.DATABASE_TEMPORARY_FAILURE,
        'The billed analysis result could not be persisted.',
      );
    }

    if (
      error instanceof RateLimitError ||
      error instanceof InternalServerError ||
      error instanceof APIConnectionTimeoutError ||
      error instanceof APIConnectionError
    ) {
      return this.retryable(
        AnalysisWorkerFailureCode.PROVIDER_TEMPORARY_FAILURE,
        'The analysis provider is temporarily unavailable.',
      );
    }

    if (
      error instanceof AuthenticationError ||
      error instanceof LlmProviderConfigurationError
    ) {
      return this.permanent(
        AnalysisWorkerFailureCode.PROVIDER_CONFIGURATION_ERROR,
        'The analysis provider is not configured correctly.',
      );
    }

    if (error instanceof BadRequestError) {
      return this.permanent(
        AnalysisWorkerFailureCode.PROVIDER_REQUEST_INVALID,
        'The analysis provider rejected the request.',
      );
    }

    if (error instanceof UnsupportedAnalysisExecutionVersionError) {
      return this.permanent(
        AnalysisWorkerFailureCode.UNSUPPORTED_ANALYSIS_VERSION,
        'The analysis execution version is not supported.',
      );
    }

    if (
      error instanceof ForbiddenException ||
      error instanceof NotFoundException ||
      error instanceof InvalidRepositoryCollectionInputError
    ) {
      return this.permanent(
        AnalysisWorkerFailureCode.REPOSITORY_UNAVAILABLE,
        'The repository is unavailable.',
      );
    }

    if (this.isRetryablePrismaError(error)) {
      return this.retryable(
        AnalysisWorkerFailureCode.DATABASE_TEMPORARY_FAILURE,
        'The database is temporarily unavailable.',
      );
    }

    const status = this.numericProperty(error, 'status');
    if (status === 429 || (status !== null && status >= 500)) {
      return this.retryable(
        AnalysisWorkerFailureCode.GITHUB_TEMPORARY_FAILURE,
        'GitHub is temporarily unavailable.',
      );
    }
    if (status === 401 || status === 403 || status === 404) {
      return this.permanent(
        AnalysisWorkerFailureCode.REPOSITORY_UNAVAILABLE,
        'The repository is unavailable.',
      );
    }

    const networkCode = this.stringProperty(error, 'code');
    if (networkCode !== null && RETRYABLE_NETWORK_CODES.has(networkCode)) {
      return this.retryable(
        AnalysisWorkerFailureCode.GITHUB_TEMPORARY_FAILURE,
        'An external service is temporarily unavailable.',
      );
    }

    return this.permanent(
      AnalysisWorkerFailureCode.ANALYSIS_FAILED,
      'Analysis failed.',
    );
  }

  private isRetryablePrismaError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return RETRYABLE_PRISMA_CODES.has(error.code);
    }
    return (
      error instanceof Prisma.PrismaClientInitializationError ||
      error instanceof Prisma.PrismaClientUnknownRequestError ||
      error instanceof Prisma.PrismaClientRustPanicError
    );
  }

  private numericProperty(error: unknown, property: string): number | null {
    if (typeof error !== 'object' || error === null || !(property in error)) {
      return null;
    }
    const value: unknown = error[property];
    return typeof value === 'number' ? value : null;
  }

  private stringProperty(error: unknown, property: string): string | null {
    if (typeof error !== 'object' || error === null || !(property in error)) {
      return null;
    }
    const value: unknown = error[property];
    return typeof value === 'string' ? value : null;
  }

  private retryable(
    code: AnalysisWorkerFailureCode,
    message: string,
  ): AnalysisWorkerErrorClassification {
    return { code, message, retryable: true };
  }

  private permanent(
    code: AnalysisWorkerFailureCode,
    message: string,
  ): AnalysisWorkerErrorClassification {
    return { code, message, retryable: false };
  }
}
