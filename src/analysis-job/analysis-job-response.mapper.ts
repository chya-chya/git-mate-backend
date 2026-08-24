import { Injectable } from '@nestjs/common';
import { AnalysisJobStatus } from '@prisma/client';
import { AnalysisJobResponseDto } from './dto/analysis-job.dto';
import { AnalysisJobApiRecord } from './analysis-job-api.types';

const PUBLIC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ANALYSIS_FAILED: '분석을 완료하지 못했습니다.',
  INSUFFICIENT_TOKENS: '분석에 필요한 토큰이 부족합니다.',
  MAX_ATTEMPTS_EXCEEDED: '최대 재시도 횟수를 초과했습니다.',
  NO_ANALYZABLE_DATA: '분석할 수 있는 저장소 활동이 없습니다.',
  PUBLISH_FAILED: '분석 작업을 처리 대기열에 등록하지 못했습니다.',
  PROVIDER_RECONCILIATION_REQUIRED:
    '분석 사용량을 확인 중입니다. 잠시 후 다시 확인해 주세요.',
  REPOSITORY_UNAVAILABLE: '저장소에 접근할 수 없습니다.',
  TOKEN_BUDGET_EXCEEDED: '분석 토큰 한도를 초과했습니다.',
};

@Injectable()
export class AnalysisJobResponseMapper {
  toDto(job: AnalysisJobApiRecord): AnalysisJobResponseDto {
    const result = job.report
      ? {
          reportId: job.report.id,
          href: `/analysis/reports/${job.report.id}`,
        }
      : null;
    const errorCode = job.lastErrorCode;
    const publicErrorMessage = errorCode
      ? PUBLIC_ERROR_MESSAGES[errorCode]
      : undefined;
    const error =
      job.status === AnalysisJobStatus.FAILED && errorCode
        ? {
            code: publicErrorMessage ? errorCode : 'ANALYSIS_FAILED',
            message: publicErrorMessage ?? '분석 작업을 완료하지 못했습니다.',
            retryable: job.errorRetryable === true,
          }
        : null;

    return {
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      attempt: job.attemptCount,
      repository: job.repository,
      tokens: {
        estimated: job.estimatedTokens,
        reserved: job.reservedTokens,
        consumed: job.totalTokens,
      },
      result,
      error,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      updatedAt: job.updatedAt.toISOString(),
      links: {
        self: `/analysis/jobs/${job.id}`,
      },
    };
  }
}
