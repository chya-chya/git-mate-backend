import { CollectedDataDto } from '../../collection/types/github-api.types';
import {
  ANALYSIS_METRIC_KEYS,
  AnalysisEvidence,
  LlmAnalysisPayload,
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

  it('rejects PR references inside evidence score rationale', () => {
    const result = makeResult({
      prNumber: 10,
      permalink: 'https://github.com/owner/repo/pull/10',
      author: 'TargetDev',
      quote: 'Target title',
      scoreRationale: '입력에 없는 PR #999의 성과까지 반영했습니다.',
    });

    expect(validateAnalysisEvidence(result, data)).toContainEqual({
      code: 'UNSTRUCTURED_REFERENCE',
      metric: 'mutual_respect',
      evidenceIndex: 0,
    });
  });

  it('rejects a source type and target relation that do not correspond', () => {
    const result = makeResult({
      prNumber: 10,
      permalink: 'https://github.com/owner/repo/pull/10',
      author: 'TargetDev',
      quote: 'Target title',
      sourceType: 'pull_request',
      targetRelation: 'target_authored_review',
    });

    expect(validateAnalysisEvidence(result, data)).toContainEqual({
      code: 'SOURCE_RELATION_MISMATCH',
      metric: 'mutual_respect',
      evidenceIndex: 0,
    });
  });

  it('rejects high or low scores when no owned evidence exists', () => {
    const result = makeResult();
    result.mutual_respect.score = 5;

    expect(validateAnalysisEvidence(result, data)).toContainEqual({
      code: 'UNSUPPORTED_SCORE_WITHOUT_EVIDENCE',
      metric: 'mutual_respect',
      evidenceIndex: null,
    });
  });

  it.each([
    ['bare PR number', '검토 결과는 #999에서 확인했습니다.'],
    [
      'GitHub issue URL',
      'https://github.com/owner/repo/issues/999에서 확인했습니다.',
    ],
    [
      'GitHub commit URL',
      'https://github.com/owner/repo/commit/abcdef에서 확인했습니다.',
    ],
    ['plain GitHub URL', 'github.com/owner/repo/wiki에서 확인했습니다.'],
    ['GitHub shorthand', 'owner/repo#999에서 확인했습니다.'],
    ['Korean number-first PR reference', '999번 PR에서 검증했습니다.'],
    ['Korean number-first spaced PR reference', '999 번 PR에서 검증했습니다.'],
    ['Korean number-first compact PR reference', '999번PR에서 검증했습니다.'],
    [
      'Korean number-first pull request reference',
      '999 번 pull request에서 검증했습니다.',
    ],
  ])('rejects %s outside structured evidence', (_name, narrative) => {
    const result = makeResult();
    result.mutual_respect.reason = narrative;

    expect(validateAnalysisEvidence(result, data)).toContainEqual({
      code: 'UNSTRUCTURED_REFERENCE',
      metric: 'mutual_respect',
      evidenceIndex: null,
    });
  });

  it.each([
    ['C# language version', 'C#8 nullable reference types를 적용했습니다.'],
    ['F# language version', 'F#7 기능으로 구현했습니다.'],
  ])('accepts %s as ordinary technical text', (_name, narrative) => {
    const result = makeResult();
    result.mutual_respect.reason = narrative;

    expect(validateAnalysisEvidence(result, data)).toEqual([]);
  });

  function makeResult(evidence?: {
    prNumber: number;
    permalink: string;
    author: string;
    quote: string;
    sourceType?: AnalysisEvidence['sourceType'];
    targetRelation?: AnalysisEvidence['targetRelation'];
    scoreRationale?: string;
  }): LlmAnalysisPayload {
    const normalizedEvidence = evidence
      ? {
          ...evidence,
          sourceType:
            evidence.sourceType ??
            (evidence.prNumber === 11
              ? 'review'
              : evidence.quote.includes('comment')
                ? 'review_comment'
                : 'pull_request'),
          targetRelation:
            evidence.targetRelation ??
            (evidence.prNumber === 11
              ? 'target_authored_review'
              : evidence.quote.includes('comment')
                ? 'target_authored_review_comment'
                : 'target_authored_pr'),
          scoreRationale:
            evidence.scoreRationale ?? '합성 원문으로 점수를 판단했습니다.',
        }
      : undefined;
    return {
      ...Object.fromEntries(
        ANALYSIS_METRIC_KEYS.map((metric) => [
          metric,
          {
            score: 3,
            reason: '직접 근거를 평가했습니다.',
            improvement: '검증 기준을 보강해야 합니다.',
            example: '측정 결과를 함께 검토해 주세요.',
            evidence:
              metric === 'mutual_respect' && normalizedEvidence
                ? [normalizedEvidence]
                : [],
          },
        ]),
      ),
      summary: '구조화된 근거만 사용했습니다.',
    } as LlmAnalysisPayload;
  }
});
