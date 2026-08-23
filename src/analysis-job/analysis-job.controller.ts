import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AnalysisJobStatus } from '@prisma/client';
import type { Request, Response } from 'express';
import {
  AnalysisJobAcceptanceResponse,
  AnalysisJobApiService,
  AnalysisJobRateLimitExceededException,
} from './analysis-job-api.service';
import {
  ANALYSIS_JOB_CREATION_RATE_LIMIT,
  AnalysisJobCreationRateLimitStatus,
} from './analysis-job-api.repository';
import {
  AnalysisJobApiErrorDto,
  AnalysisJobListResponseDto,
  AnalysisJobResponseDto,
  CreateAnalysisJobDto,
  ListAnalysisJobsQueryDto,
} from './dto/analysis-job.dto';
import { AnalysisJobJwtAuthGuard } from './guards/analysis-job-jwt-auth.guard';
import { AnalysisJobRateLimitGuard } from './guards/analysis-job-rate-limit.guard';
import { AsyncAnalysisEnabledGuard } from './guards/async-analysis-enabled.guard';
import { AnalysisJobUuidPipe } from './pipes/analysis-job-uuid.pipe';
import { IdempotencyKeyPipe } from './pipes/idempotency-key.pipe';
import { AnalysisJobValidationExceptionFilter } from './filters/analysis-job-validation-exception.filter';

interface AuthenticatedRequest extends Request {
  user: { id: number; username?: string };
}

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description: '1~128자의 불투명한 요청 멱등성 키',
  schema: { type: 'string', minLength: 1, maxLength: 128 },
};

const CREATION_RATE_LIMIT_RESPONSE_HEADERS = {
  'X-RateLimit-Limit-Analysis-Job': {
    description: '사용자별 분당 Job 생성 한도',
    schema: { type: 'integer', example: 5 },
  },
  'X-RateLimit-Remaining-Analysis-Job': {
    description: '현재 응답 처리 후 남은 Job 생성 가능 횟수',
    schema: { type: 'integer', example: 4 },
  },
  'X-RateLimit-Reset-Analysis-Job': {
    description: '생성 한도가 복구되기까지 남은 시간(초)',
    schema: { type: 'integer', example: 60 },
  },
};

const ACCEPTED_RESPONSE_HEADERS = {
  ...CREATION_RATE_LIMIT_RESPONSE_HEADERS,
  Location: {
    description: '접수된 Job의 상태 조회 경로',
    schema: { type: 'string' },
  },
  'Retry-After': {
    description: '권장 재조회 대기 시간(초)',
    schema: { type: 'integer', example: 2 },
  },
};

const RATE_LIMITED_RESPONSE_HEADERS = {
  ...CREATION_RATE_LIMIT_RESPONSE_HEADERS,
  'Retry-After': {
    description: '다음 Job 생성 요청까지 대기할 시간(초)',
    schema: { type: 'integer', example: 18 },
  },
};

const POLLING_RESPONSE_HEADERS = {
  'Retry-After': {
    description: '진행 중 Job이 포함된 경우 권장 재조회 대기 시간(초)',
    schema: { type: 'integer', example: 2 },
  },
};

function setPollingHeaders(response: Response, job: AnalysisJobResponseDto) {
  if (
    job.status === AnalysisJobStatus.QUEUED ||
    job.status === AnalysisJobStatus.RUNNING
  ) {
    response.setHeader('Retry-After', '2');
  }
}

function setCreationRateLimitHeaders(
  response: Response,
  rateLimit: AnalysisJobCreationRateLimitStatus,
) {
  response.setHeader(
    'X-RateLimit-Limit-Analysis-Job',
    ANALYSIS_JOB_CREATION_RATE_LIMIT,
  );
  response.setHeader('X-RateLimit-Remaining-Analysis-Job', rateLimit.remaining);
  response.setHeader(
    'X-RateLimit-Reset-Analysis-Job',
    rateLimit.retryAfterSeconds,
  );
}

@ApiTags('Analysis Jobs')
@ApiBearerAuth()
@ApiResponse({ status: 403, type: AnalysisJobApiErrorDto })
@UseGuards(AnalysisJobJwtAuthGuard, AsyncAnalysisEnabledGuard)
@UseFilters(AnalysisJobValidationExceptionFilter)
@Controller('analysis/jobs')
export class AnalysisJobController {
  constructor(
    private readonly analysisJobApiService: AnalysisJobApiService,
    private readonly idempotencyKeyPipe: IdempotencyKeyPipe,
  ) {}

  @Post()
  @HttpCode(202)
  @UseGuards(AnalysisJobRateLimitGuard)
  @ApiOperation({ summary: '멱등한 비동기 분석 Job 접수' })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: 202,
    type: AnalysisJobResponseDto,
    headers: ACCEPTED_RESPONSE_HEADERS,
  })
  @ApiResponse({ status: 400, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 401, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 404, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 409, type: AnalysisJobApiErrorDto })
  @ApiResponse({
    status: 429,
    type: AnalysisJobApiErrorDto,
    headers: RATE_LIMITED_RESPONSE_HEADERS,
  })
  @ApiResponse({ status: 503, type: AnalysisJobApiErrorDto })
  async create(
    @Body() body: CreateAnalysisJobDto,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AnalysisJobResponseDto> {
    const idempotencyKey = this.idempotencyKeyPipe.transform(rawIdempotencyKey);
    const job = await this.acceptWithRateLimitHeaders(
      response,
      this.analysisJobApiService.create(
        request.user.id,
        body.githubRepoId,
        idempotencyKey,
      ),
    );
    response.setHeader('Location', job.links.self);
    setPollingHeaders(response, job);
    return job;
  }

  @Get()
  @ApiOperation({ summary: '현재 사용자의 분석 Job 목록 조회' })
  @ApiResponse({
    status: 200,
    type: AnalysisJobListResponseDto,
    headers: POLLING_RESPONSE_HEADERS,
  })
  @ApiResponse({ status: 400, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 401, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 503, type: AnalysisJobApiErrorDto })
  async list(
    @Query() query: ListAnalysisJobsQueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AnalysisJobListResponseDto> {
    const result = await this.analysisJobApiService.list(
      request.user.id,
      query,
    );
    if (
      result.items.some(
        (job) =>
          job.status === AnalysisJobStatus.QUEUED ||
          job.status === AnalysisJobStatus.RUNNING,
      )
    ) {
      response.setHeader('Retry-After', '2');
    }
    return result;
  }

  @Get(':id')
  @ApiOperation({ summary: '현재 사용자의 분석 Job 상태 조회' })
  @ApiResponse({
    status: 200,
    type: AnalysisJobResponseDto,
    headers: POLLING_RESPONSE_HEADERS,
  })
  @ApiResponse({ status: 400, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 401, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 404, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 503, type: AnalysisJobApiErrorDto })
  async findOne(
    @Param('id', AnalysisJobUuidPipe) jobId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AnalysisJobResponseDto> {
    const job = await this.analysisJobApiService.findOne(
      request.user.id,
      jobId,
    );
    setPollingHeaders(response, job);
    return job;
  }

  @Post(':id/retry')
  @HttpCode(202)
  @UseGuards(AnalysisJobRateLimitGuard)
  @ApiOperation({ summary: '재시도 가능한 실패 Job을 새 Job으로 재접수' })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: 202,
    type: AnalysisJobResponseDto,
    headers: ACCEPTED_RESPONSE_HEADERS,
  })
  @ApiResponse({ status: 400, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 401, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 404, type: AnalysisJobApiErrorDto })
  @ApiResponse({ status: 409, type: AnalysisJobApiErrorDto })
  @ApiResponse({
    status: 429,
    type: AnalysisJobApiErrorDto,
    headers: RATE_LIMITED_RESPONSE_HEADERS,
  })
  @ApiResponse({ status: 503, type: AnalysisJobApiErrorDto })
  async retry(
    @Param('id', AnalysisJobUuidPipe) jobId: string,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AnalysisJobResponseDto> {
    const idempotencyKey = this.idempotencyKeyPipe.transform(rawIdempotencyKey);
    const job = await this.acceptWithRateLimitHeaders(
      response,
      this.analysisJobApiService.retry(request.user.id, jobId, idempotencyKey),
    );
    response.setHeader('Location', job.links.self);
    setPollingHeaders(response, job);
    return job;
  }

  private async acceptWithRateLimitHeaders(
    response: Response,
    operation: Promise<AnalysisJobAcceptanceResponse>,
  ): Promise<AnalysisJobResponseDto> {
    try {
      const accepted = await operation;
      setCreationRateLimitHeaders(response, accepted.rateLimit);
      return accepted.job;
    } catch (error) {
      if (error instanceof AnalysisJobRateLimitExceededException) {
        setCreationRateLimitHeaders(response, error.rateLimit);
        response.setHeader('Retry-After', error.rateLimit.retryAfterSeconds);
      }
      throw error;
    }
  }
}
