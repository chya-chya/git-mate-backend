import {
  ANALYSIS_METRIC_KEYS,
  LlmAnalysisResult,
  analysisResultSchema,
} from '../analysis-result.schema';

describe('analysisResultSchema', () => {
  const valid = {
    ...Object.fromEntries(
      ANALYSIS_METRIC_KEYS.map((metric) => [
        metric,
        {
          score: 3.5,
          reason: '직접 근거를 기준으로 평가했습니다.',
          improvement: '검증 기준을 더 구체화해야 합니다.',
          example: '측정 결과를 함께 검토해 주세요.',
          evidence: [],
        },
      ]),
    ),
    summary: '합성 입력에 대한 요약입니다.',
  } as LlmAnalysisResult;

  it('accepts all eight strict metric objects and summary', () => {
    expect(analysisResultSchema.safeParse(valid).success).toBe(true);
  });

  const invalidCases: Array<[string, () => unknown]> = [
    ['missing field', () => ({ ...valid, summary: undefined })],
    ['extra field', () => ({ ...valid, extra: true })],
    [
      'nested extra field',
      () => ({
        ...valid,
        mutual_respect: { ...valid.mutual_respect, extra: true },
      }),
    ],
    [
      'NaN score',
      () => ({
        ...valid,
        mutual_respect: { ...valid.mutual_respect, score: Number.NaN },
      }),
    ],
    [
      'score below one',
      () => ({
        ...valid,
        mutual_respect: { ...valid.mutual_respect, score: 0.5 },
      }),
    ],
    [
      'score above five',
      () => ({
        ...valid,
        mutual_respect: { ...valid.mutual_respect, score: 5.5 },
      }),
    ],
    [
      'non half-step score',
      () => ({
        ...valid,
        mutual_respect: { ...valid.mutual_respect, score: 3.2 },
      }),
    ],
    [
      'non-canonical evidence permalink',
      () => ({
        ...valid,
        mutual_respect: {
          ...valid.mutual_respect,
          evidence: [
            {
              prNumber: 1,
              permalink: 'https://example.com/pull/1',
              author: 'developer',
              quote: 'synthetic quote',
            },
          ],
        },
      }),
    ],
  ];

  it.each(invalidCases)('rejects %s', (_name, makeCandidate) => {
    expect(analysisResultSchema.safeParse(makeCandidate()).success).toBe(false);
  });
});
