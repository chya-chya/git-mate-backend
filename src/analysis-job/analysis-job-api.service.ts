import { createHash } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AnalysisJobStatus } from '@prisma/client';
import { CURRENT_ANALYSIS_EXECUTION_VERSION } from '../analysis/analysis-execution-version';
import {
  AnalysisJobListResponseDto,
  AnalysisJobResponseDto,
  ListAnalysisJobsQueryDto,
} from './dto/analysis-job.dto';
import {
  AnalysisJobApiRepository,
  AnalysisJobCreationRateLimitStatus,
} from './analysis-job-api.repository';
import {
  AnalysisJobApiRecord,
  AnalysisJobCursor,
} from './analysis-job-api.types';
import { AnalysisJobResponseMapper } from './analysis-job-response.mapper';
import {
  ActiveAnalysisJobExistsError,
  AnalysisJobRepository,
} from './analysis-job.repository';
import { AnalysisJobPublisherService } from './analysis-job-publisher.service';

type JobRequest =
  | { type: 'CREATE'; githubRepoId: string }
  | { type: 'RETRY'; sourceJobId: string };

export interface AnalysisJobAcceptanceResponse {
  job: AnalysisJobResponseDto;
  rateLimit: AnalysisJobCreationRateLimitStatus;
}

interface AcceptedAnalysisJob {
  record: AnalysisJobApiRecord;
  rateLimit: AnalysisJobCreationRateLimitStatus;
}

export class AnalysisJobRateLimitExceededException extends HttpException {
  constructor(readonly rateLimit: AnalysisJobCreationRateLimitStatus) {
    super(
      {
        code: 'RATE_LIMITED',
        message: 'Analysis job creation rate limit exceeded.',
      },
      429,
    );
  }
}

@Injectable()
export class AnalysisJobApiService {
  constructor(
    private readonly repository: AnalysisJobApiRepository,
    private readonly responseMapper: AnalysisJobResponseMapper,
    private readonly creationRepository: AnalysisJobRepository,
    private readonly publisher: AnalysisJobPublisherService,
  ) {}

  async create(
    userId: number,
    githubRepoId: string,
    idempotencyKey: string,
  ): Promise<AnalysisJobAcceptanceResponse> {
    const request: JobRequest = { type: 'CREATE', githubRepoId };
    const accepted = await this.acceptJob(userId, idempotencyKey, request);
    await this.publisher.publishAcceptedJob(accepted.record);
    return {
      job: this.responseMapper.toDto(accepted.record),
      rateLimit: accepted.rateLimit,
    };
  }

  async retry(
    userId: number,
    sourceJobId: string,
    idempotencyKey: string,
  ): Promise<AnalysisJobAcceptanceResponse> {
    const sourceJob = await this.repository.findOwnedById(userId, sourceJobId);
    if (!sourceJob) {
      throw this.notFound('JOB_NOT_FOUND', 'Analysis job was not found.');
    }
    if (
      sourceJob.status !== AnalysisJobStatus.FAILED ||
      sourceJob.errorRetryable !== true
    ) {
      throw this.conflict(
        'JOB_NOT_RETRYABLE',
        'Analysis job cannot be retried.',
      );
    }

    const request: JobRequest = { type: 'RETRY', sourceJobId };
    const accepted = await this.acceptJob(
      userId,
      idempotencyKey,
      request,
      sourceJob,
    );
    await this.publisher.publishAcceptedJob(accepted.record);
    return {
      job: this.responseMapper.toDto(accepted.record),
      rateLimit: accepted.rateLimit,
    };
  }

  async findOne(
    userId: number,
    jobId: string,
  ): Promise<AnalysisJobResponseDto> {
    const job = await this.repository.findOwnedById(userId, jobId);
    if (!job) {
      throw this.notFound('JOB_NOT_FOUND', 'Analysis job was not found.');
    }
    return this.responseMapper.toDto(job);
  }

  async list(
    userId: number,
    query: ListAnalysisJobsQueryDto,
  ): Promise<AnalysisJobListResponseDto> {
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : undefined;
    const jobs = await this.repository.listOwned({
      userId,
      repositoryId: query.repositoryId,
      status: query.status,
      limit: query.limit,
      cursor,
    });
    const hasNextPage = jobs.length > query.limit;
    const page = hasNextPage ? jobs.slice(0, query.limit) : jobs;
    const lastJob = page.at(-1);

    return {
      items: page.map((job) => this.responseMapper.toDto(job)),
      nextCursor:
        hasNextPage && lastJob
          ? this.encodeCursor({ createdAt: lastJob.createdAt, id: lastJob.id })
          : null,
    };
  }

  private async acceptJob(
    userId: number,
    idempotencyKey: string,
    request: JobRequest,
    retrySource?: AnalysisJobApiRecord,
  ): Promise<AcceptedAnalysisJob> {
    const requestHash = this.createRequestHash(userId, request);

    try {
      return await this.repository.transaction(async (database) => {
        await this.repository.acquireTransactionLock(
          `analysis-job-idempotency:${userId}:${idempotencyKey}`,
          database,
        );
        const existing = await this.repository.findByIdempotencyKey(
          userId,
          idempotencyKey,
          database,
        );
        if (existing) {
          return {
            record: this.resolveExisting(existing, requestHash),
            rateLimit: await this.repository.getCreationRateLimitStatus(
              userId,
              database,
            ),
          };
        }

        await this.repository.acquireTransactionLock(
          `analysis-job-rate-limit:${userId}`,
          database,
        );
        const rateLimit = await this.repository.getCreationRateLimitStatus(
          userId,
          database,
        );
        if (rateLimit.isBlocked) {
          throw new AnalysisJobRateLimitExceededException(rateLimit);
        }

        const githubRepoId =
          request.type === 'CREATE'
            ? request.githubRepoId
            : retrySource?.repository.githubRepoId;
        if (!githubRepoId) {
          throw this.notFound('JOB_NOT_FOUND', 'Analysis job was not found.');
        }

        const repository = await this.repository.findOwnedRepositoryByGithubId(
          userId,
          githubRepoId,
          database,
        );
        if (!repository) {
          throw this.notFound(
            'REPOSITORY_NOT_FOUND',
            'Repository was not found.',
          );
        }
        if (repository.owner.availableTokens <= 0) {
          throw this.conflict(
            'INSUFFICIENT_TOKENS',
            'Available tokens are required to create an analysis job.',
          );
        }

        const record = await this.creationRepository.createExclusive(
          repository.id,
          (creationDatabase) =>
            this.repository.create(
              {
                userId,
                repositoryId: repository.id,
                idempotencyKey,
                requestHash,
                sourceCursor:
                  request.type === 'RETRY'
                    ? (retrySource?.sourceCursor ?? null)
                    : repository.lastSyncTime,
                ...CURRENT_ANALYSIS_EXECUTION_VERSION,
              },
              creationDatabase,
            ),
          database,
        );
        return {
          record,
          rateLimit: await this.repository.getCreationRateLimitStatus(
            userId,
            database,
          ),
        };
      });
    } catch (error) {
      if (this.isIdempotencyUniqueConflict(error)) {
        const existing = await this.repository.findByIdempotencyKey(
          userId,
          idempotencyKey,
        );
        if (existing) {
          return {
            record: this.resolveExisting(existing, requestHash),
            rateLimit: await this.repository.getCreationRateLimitStatus(userId),
          };
        }
      }
      if (error instanceof HttpException) {
        throw error;
      }
      if (error instanceof ActiveAnalysisJobExistsError) {
        throw this.conflict(
          'ACTIVE_JOB_EXISTS',
          'An active analysis job already exists for this repository.',
        );
      }
      throw new ServiceUnavailableException({
        code: 'JOB_ACCEPTANCE_UNAVAILABLE',
        message: 'Analysis job acceptance is temporarily unavailable.',
      });
    }
  }

  private resolveExisting(
    existing: AnalysisJobApiRecord,
    requestHash: string,
  ): AnalysisJobApiRecord {
    if (existing.requestHash !== requestHash) {
      throw this.conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used for a different request.',
      );
    }
    return existing;
  }

  private createRequestHash(userId: number, request: JobRequest): string {
    const canonicalRequest = JSON.stringify({
      userId,
      request,
    });
    return createHash('sha256').update(canonicalRequest).digest('hex');
  }

  private encodeCursor(cursor: AnalysisJobCursor): string {
    return Buffer.from(
      JSON.stringify({
        createdAt: cursor.createdAt.toISOString(),
        id: cursor.id,
      }),
    ).toString('base64url');
  }

  private decodeCursor(cursor: string): AnalysisJobCursor {
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      if (!this.isCursorPayload(decoded)) {
        throw new Error('invalid cursor payload');
      }
      const createdAt = new Date(decoded.createdAt);
      if (Number.isNaN(createdAt.getTime())) {
        throw new Error('invalid cursor date');
      }
      return { createdAt, id: decoded.id };
    } catch {
      throw new HttpException(
        { code: 'INVALID_REQUEST', message: 'Cursor is invalid.' },
        400,
      );
    }
  }

  private isCursorPayload(
    value: unknown,
  ): value is { createdAt: string; id: string } {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      Object.keys(record).length === 2 &&
      typeof record.createdAt === 'string' &&
      typeof record.id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        record.id,
      )
    );
  }

  private isIdempotencyUniqueConflict(
    error: unknown,
  ): error is { code: 'P2002' } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }

  private notFound(code: string, message: string): NotFoundException {
    return new NotFoundException({ code, message });
  }

  private conflict(code: string, message: string): ConflictException {
    return new ConflictException({ code, message });
  }
}
