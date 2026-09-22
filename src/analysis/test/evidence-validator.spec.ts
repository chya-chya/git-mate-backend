import { CollectedDataDto } from '../../collection/types/github-api.types';
import {
  ANALYSIS_METRIC_KEYS,
  LlmAnalysisResult,
} from '../analysis-result.schema';
import { validateAnalysisEvidence } from '../evidence-validator';

describe('validateAnalysisEvidence', () => {
  const data: CollectedDataDto = {
    githubRepoId: 'synthetic',
    owner: 'owner',
    repo: 'repo',
    targetUser: 'TargetDev',
    pullRequests: [
      {
        number: 10,
        title: 'Target title',
        body: 'Target   PR body\r\nwith details.',
        author: 'targetdev',
        updatedAt: '2026-01-01T00:00:00.000Z',
        permalink: 'https://github.com/owner/repo/pull/10',
        reviews: [
          {
            author: 'OtherDev',
            body: 'Other review body with shared phrase.',
            state: 'COMMENTED',
            comments: [
              {
                author: 'TARGETDEV',
                body: 'Target comment body with shared phrase.',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
              {
                author: 'OtherDev',
                body: 'Other comment body.',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        ],
      },
      {
        number: 11,
        title: 'Other PR',
        body: 'Other PR body.',
        author: 'OtherDev',
        updatedAt: '2026-01-01T00:00:00.000Z',
        permalink: 'https://github.com/owner/repo/pull/11',
        reviews: [
          {
            author: 'TargetDev',
            body: 'Target review on another user PR.',
            state: 'COMMENTED',
            comments: [],
          },
        ],
      },
    ],
  };

  it.each([
    [10, 'Target PR body with details.'],
    [10, 'Target comment body with shared phrase.'],
    [11, 'Target review on another user PR.'],
  ])('accepts target-owned activity for PR %s', (prNumber, quote) => {
    const result = makeResult({
      prNumber,
      permalink: `https://github.com/owner/repo/pull/${prNumber}`,
      author: 'TARGETDEV',
      quote,
    });

    expect(validateAnalysisEvidence(result, data)).toEqual([]);
  });

  it.each([
    [
      'unknown PR',
      {
        prNumber: 999,
        permalink: 'https://github.com/owner/repo/pull/999',
        author: 'TargetDev',
        quote: 'Target title',
      },
      'UNKNOWN_PR',
    ],
    [
      'number/permalink mismatch',
      {
        prNumber: 10,
        permalink: 'https://github.com/owner/repo/pull/11',
        author: 'TargetDev',
        quote: 'Target title',
      },
      'PERMALINK_MISMATCH',
    ],
    [
      'forged author',
      {
        prNumber: 10,
        permalink: 'https://github.com/owner/repo/pull/10',
        author: 'OtherDev',
        quote: 'Target title',
      },
      'AUTHOR_MISMATCH',
    ],
    [
      'other review quote',
      {
        prNumber: 10,
        permalink: 'https://github.com/owner/repo/pull/10',
        author: 'TargetDev',
        quote: 'Other review body',
      },
      'QUOTE_NOT_OWNED',
    ],
    [
      'other comment quote',
      {
        prNumber: 10,
        permalink: 'https://github.com/owner/repo/pull/10',
        author: 'TargetDev',
        quote: 'Other comment body.',
      },
      'QUOTE_NOT_OWNED',
    ],
    [
      'stitched quote',
      {
        prNumber: 10,
        permalink: 'https://github.com/owner/repo/pull/10',
        author: 'TargetDev',
        quote: 'Target title Target comment body',
      },
      'QUOTE_NOT_OWNED',
    ],
  ])('rejects %s', (_name, evidence, expectedCode) => {
    expect(validateAnalysisEvidence(makeResult(evidence), data)).toContainEqual(
      expect.objectContaining({ code: expectedCode }),
    );
  });

  it('rejects PR references outside structured evidence', () => {
    const result = makeResult();
    result.summary = 'PR #10에서 잘했습니다.';
    result.mutual_respect.reason =
      'https://github.com/owner/repo/pull/10에서 확인했습니다.';

    expect(validateAnalysisEvidence(result, data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNSTRUCTURED_REFERENCE',
          metric: 'mutual_respect',
        }),
        expect.objectContaining({
          code: 'UNSTRUCTURED_REFERENCE',
          metric: 'summary',
        }),
      ]),
    );
  });

  function makeResult(evidence?: {
    prNumber: number;
    permalink: string;
    author: string;
    quote: string;
  }): LlmAnalysisResult {
    return {
      ...Object.fromEntries(
        ANALYSIS_METRIC_KEYS.map((metric) => [
          metric,
          {
            score: 3,
            reason: '직접 근거를 평가했습니다.',
            improvement: '검증 기준을 보강해야 합니다.',
            example: '측정 결과를 함께 검토해 주세요.',
            evidence: metric === 'mutual_respect' && evidence ? [evidence] : [],
          },
        ]),
      ),
      summary: '구조화된 근거만 사용했습니다.',
    } as LlmAnalysisResult;
  }
});
