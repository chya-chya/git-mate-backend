import { AnalysisJobStage, AnalysisJobStatus } from '@prisma/client';
import { AnalysisJobApiRecord } from '../analysis-job-api.types';
import { AnalysisJobResponseMapper } from '../analysis-job-response.mapper';

function createRecord(
  overrides: Partial<AnalysisJobApiRecord> = {},
): AnalysisJobApiRecord {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    status: AnalysisJobStatus.SUCCEEDED,
    stage: null,
    progress: 100,
    userId: 7,
    repositoryId: 17,
    idempotencyKey: 'legacy-report:1',
    requestHash: 'a'.repeat(64),
    sourceCursor: null,
    modelVersion: 'legacy',
    promptVersion: 'legacy',
    estimatedTokens: null,
    reservedTokens: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    tokensSettledAt: new Date('2026-08-16T00:01:00.000Z'),
    providerRequestIds: ['provider-secret-id'],
    publishAttempts: 0,
    messagePublishedAt: null,
    nextPublishAt: null,
    attemptCount: 1,
    maxAttempts: 5,
    leaseToken: 'internal-lease-token',
    leaseExpiresAt: null,
    heartbeatAt: null,
    lastErrorCode: null,
    lastErrorMessage: 'internal provider response',
    errorRetryable: null,
    startedAt: new Date('2026-08-16T00:00:00.000Z'),
    completedAt: new Date('2026-08-16T00:01:00.000Z'),
    createdAt: new Date('2026-08-16T00:00:00.000Z'),
    updatedAt: new Date('2026-08-16T00:01:00.000Z'),
    repository: {
      id: 17,
      githubRepoId: '123456789',
      fullName: 'octocat/example',
    },
    report: { id: 481 },
    ...overrides,
  };
}

describe('AnalysisJobResponseMapper', () => {
  const mapper = new AnalysisJobResponseMapper();

  it('maps legacy unknown usage to null and exposes only the report link', () => {
    const response = mapper.toDto(createRecord());

    expect(response.tokens.consumed).toBeNull();
    expect(response.result).toEqual({
      reportId: 481,
      href: '/analysis/reports/481',
    });
    expect(response).not.toHaveProperty('leaseToken');
    expect(response).not.toHaveProperty('providerRequestIds');
    expect(response).not.toHaveProperty('lastErrorMessage');
  });

  it('uses a server-owned safe message instead of stored internal error text', () => {
    const response = mapper.toDto(
      createRecord({
        status: AnalysisJobStatus.FAILED,
        stage: AnalysisJobStage.ANALYZING,
        progress: 35,
        report: null,
        lastErrorCode: 'ANALYSIS_FAILED',
        lastErrorMessage: 'provider request abc failed with raw response',
        errorRetryable: true,
      }),
    );

    expect(response.error).toEqual({
      code: 'ANALYSIS_FAILED',
      message: '분석을 완료하지 못했습니다.',
      retryable: true,
    });
  });

  it('replaces an unknown internal error code with a public fallback', () => {
    const response = mapper.toDto(
      createRecord({
        status: AnalysisJobStatus.FAILED,
        report: null,
        lastErrorCode: 'INTERNAL_PROVIDER_FAILURE',
        errorRetryable: false,
      }),
    );

    expect(response.error).toEqual({
      code: 'ANALYSIS_FAILED',
      message: '분석 작업을 완료하지 못했습니다.',
      retryable: false,
    });
  });
});
