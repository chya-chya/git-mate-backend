import { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AnalysisJobRateLimitGuard } from '../guards/analysis-job-rate-limit.guard';
import { AsyncAnalysisEnabledGuard } from '../guards/async-analysis-enabled.guard';
import { AnalysisJobUuidPipe } from '../pipes/analysis-job-uuid.pipe';
import { IdempotencyKeyPipe } from '../pipes/idempotency-key.pipe';

function createHttpContext(userId?: number): ExecutionContext {
  const response = { setHeader: jest.fn() };
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: userId === undefined ? undefined : { id: userId },
      }),
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function getErrorCode(error: unknown): unknown {
  if (!(error instanceof HttpException)) {
    throw error;
  }
  const response = error.getResponse();
  if (typeof response !== 'object' || response === null) {
    throw new Error('Expected a structured API error');
  }
  return (response as Record<string, unknown>).code;
}

function expectSyncApiError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected API error ${code}`);
  } catch (error) {
    expect(getErrorCode(error)).toBe(code);
  }
}

async function expectAsyncApiError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected API error ${code}`);
  } catch (error) {
    expect(getErrorCode(error)).toBe(code);
  }
}

describe('Analysis Job API security boundaries', () => {
  it.each([undefined, 'false', 'TRUE', '1'])(
    'fails closed when ASYNC_ANALYSIS_ENABLED is %s',
    (value) => {
      const guard = new AsyncAnalysisEnabledGuard(
        new ConfigService({ ASYNC_ANALYSIS_ENABLED: value }),
      );

      expectSyncApiError(() => guard.canActivate(), 'ASYNC_ANALYSIS_DISABLED');
    },
  );

  it('enables the API only for the exact string true', () => {
    const guard = new AsyncAnalysisEnabledGuard(
      new ConfigService({ ASYNC_ANALYSIS_ENABLED: 'true' }),
    );

    expect(guard.canActivate()).toBe(true);
  });

  it('shares one five-per-minute bucket across creation routes per user', async () => {
    const increment: jest.MockedFunction<ThrottlerStorage['increment']> = jest
      .fn<ThrottlerStorage['increment']>()
      .mockResolvedValueOnce({
        totalHits: 5,
        timeToExpire: 30,
        isBlocked: false,
        timeToBlockExpire: 0,
      })
      .mockResolvedValueOnce({
        totalHits: 6,
        timeToExpire: 29,
        isBlocked: true,
        timeToBlockExpire: 29,
      })
      .mockResolvedValueOnce({
        totalHits: 1,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    const guard = new AnalysisJobRateLimitGuard({
      increment,
    } as unknown as ThrottlerStorage);

    await expect(guard.canActivate(createHttpContext(7))).resolves.toBe(true);
    await expectAsyncApiError(
      guard.canActivate(createHttpContext(7)),
      'RATE_LIMITED',
    );
    await expect(guard.canActivate(createHttpContext(8))).resolves.toBe(true);

    expect(increment.mock.calls.map(([key]) => key)).toEqual([
      'analysis-job-create:user:7',
      'analysis-job-create:user:7',
      'analysis-job-create:user:8',
    ]);
  });

  it('fails closed if the authenticated user is not available to the rate guard', async () => {
    const guard = new AnalysisJobRateLimitGuard({
      increment: jest.fn(),
    } as unknown as ThrottlerStorage);

    await expectAsyncApiError(
      guard.canActivate(createHttpContext()),
      'UNAUTHORIZED',
    );
  });

  it.each([
    undefined,
    '',
    'legacy-report:1',
    'contains\ncontrol',
    'a'.repeat(129),
  ])('rejects an unsafe idempotency key: %s', (value) => {
    expectSyncApiError(
      () => new IdempotencyKeyPipe().transform(value),
      'INVALID_REQUEST',
    );
  });

  it('accepts legacy and current UUID shapes but rejects malformed IDs', () => {
    const pipe = new AnalysisJobUuidPipe();
    expect(pipe.transform('11111111-1111-1111-1111-111111111111')).toBe(
      '11111111-1111-1111-1111-111111111111',
    );
    expectSyncApiError(() => pipe.transform('not-a-uuid'), 'INVALID_REQUEST');
  });
});
