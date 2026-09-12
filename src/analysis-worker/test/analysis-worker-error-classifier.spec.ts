import { ForbiddenException } from '@nestjs/common';
import {
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from 'openai';
import {
  AnalysisWorkerErrorClassifier,
  AnalysisWorkerFailureCode,
} from '../analysis-worker-error-classifier';
import { InputLimitExceededError } from '../../collection/collection-limits';
import {
  GithubPaginationError,
  GithubRateLimitError,
} from '../../collection/github-errors';

describe('AnalysisWorkerErrorClassifier', () => {
  const classifier = new AnalysisWorkerErrorClassifier();
  const headers = new Headers();

  it.each([
    new RateLimitError(429, {}, 'rate limited', headers),
    new InternalServerError(500, {}, 'provider unavailable', headers),
    new APIConnectionTimeoutError({ message: 'timed out' }),
  ])('classifies transient OpenAI failures as retryable', (error) => {
    expect(classifier.classify(error)).toMatchObject({
      code: AnalysisWorkerFailureCode.PROVIDER_TEMPORARY_FAILURE,
      retryable: true,
    });
  });

  it.each([
    new AuthenticationError(401, {}, 'unauthorized', headers),
    new BadRequestError(400, {}, 'invalid', headers),
  ])('classifies permanent OpenAI failures as terminal', (error) => {
    expect(classifier.classify(error).retryable).toBe(false);
  });

  it.each([{ status: 429 }, { status: 502 }, { code: 'ETIMEDOUT' }])(
    'classifies transient GitHub failures as retryable',
    (error) => {
      expect(classifier.classify(error).retryable).toBe(true);
    },
  );

  it('classifies permanent GitHub installation failures as terminal', () => {
    expect(classifier.classify(new ForbiddenException())).toMatchObject({
      code: AnalysisWorkerFailureCode.REPOSITORY_UNAVAILABLE,
      retryable: false,
    });
  });

  it('distinguishes rate limits, pagination failures, and input limits', () => {
    const retryAt = new Date('2026-09-12T00:01:00.000Z');
    expect(
      classifier.classify(new GithubRateLimitError(403, retryAt)),
    ).toMatchObject({
      code: AnalysisWorkerFailureCode.GITHUB_TEMPORARY_FAILURE,
      retryable: true,
      retryAt,
    });
    expect(
      classifier.classify(new GithubPaginationError('review', 'bad cursor')),
    ).toMatchObject({
      code: AnalysisWorkerFailureCode.GITHUB_PAGINATION_INVALID,
      retryable: false,
    });
    expect(
      classifier.classify(
        new InputLimitExceededError('changed pull requests', 100, 101),
      ),
    ).toMatchObject({
      code: AnalysisWorkerFailureCode.INPUT_LIMIT_EXCEEDED,
      retryable: false,
    });
  });
});
