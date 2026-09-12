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
});
