import { ANALYSIS_METRIC_KEYS } from '../analysis-result.schema';
import { ANALYSIS_GOLDEN_FIXTURES } from '../evals/golden-fixtures';
import {
  AnalysisEvalInput,
  ANALYSIS_EVAL_TOTAL_CASES,
  ANALYSIS_EVAL_TOTAL_LABELS,
  gradeAnalysisOutputs,
} from '../evals/grader';
import { CHECKED_IN_REFERENCE_OUTPUTS } from '../evals/reference-outputs';

describe('analysis evaluation fixtures and grader', () => {
  it('contains exactly 24 uniquely labeled synthetic fixtures', () => {
    expect(ANALYSIS_GOLDEN_FIXTURES).toHaveLength(24);
    expect(
      new Set(ANALYSIS_GOLDEN_FIXTURES.map((fixture) => fixture.id)).size,
    ).toBe(24);
    for (const fixture of ANALYSIS_GOLDEN_FIXTURES) {
      expect(Object.keys(fixture.expectedScoreBands).sort()).toEqual(
        [...ANALYSIS_METRIC_KEYS].sort(),
      );
      expect(fixture.input.githubRepoId).toMatch(/^synthetic-/);
    }
    const tags = [
      ...new Set(ANALYSIS_GOLDEN_FIXTURES.flatMap((fixture) => fixture.tags)),
    ];
    expect(tags).toEqual(
      expect.arrayContaining([
        'nonexistent-pr-999',
        'prompt-injection',
        'duplicate-ambiguous-quote',
        'case-insensitive-github-id',
        'sparse-evidence',
      ]),
    );
  });

  it('grades checked-in reference outputs without an API key or network client', () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(gradeAnalysisOutputs(CHECKED_IN_REFERENCE_OUTPUTS)).toMatchObject({
        passed: true,
        totalCases: ANALYSIS_EVAL_TOTAL_CASES,
        schemaPassedCases: 24,
        fabricatedPrCitations: 0,
        wrongUserAttributions: 0,
        evidenceValidationFailures: 0,
        scoreBandMatchingLabels: ANALYSIS_EVAL_TOTAL_LABELS,
        scoreBandTotalLabels: ANALYSIS_EVAL_TOTAL_LABELS,
      });
    } finally {
      if (previousApiKey !== undefined) {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });

  it('keeps missing outputs in the fixed 24-case and 192-label denominator', () => {
    const summary = gradeAnalysisOutputs(
      CHECKED_IN_REFERENCE_OUTPUTS.slice(0, -1),
    );

    expect(summary.totalCases).toBe(24);
    expect(summary.scoreBandTotalLabels).toBe(192);
    expect(summary.missingOutputs).toBe(1);
    expect(summary.passed).toBe(false);
  });

  it('detects fabricated citations, wrong-user attribution, and empty evidence bypasses', () => {
    const fixture = ANALYSIS_GOLDEN_FIXTURES[0];
    const reference = structuredClone(CHECKED_IN_REFERENCE_OUTPUTS[0]);
    const output = reference.output as Record<
      string,
      { evidence: Array<Record<string, unknown>> }
    >;
    output[fixture.focusMetric].evidence = [
      {
        prNumber: 999,
        permalink: 'https://github.com/synthetic-org/quality-fixtures/pull/999',
        author: 'AnotherUser',
        sourceType: 'pull_request',
        targetRelation: 'target_authored_pr',
        quote: 'Invented quote',
        scoreRationale: '존재하지 않는 합성 근거입니다.',
      },
    ];
    const replacements = CHECKED_IN_REFERENCE_OUTPUTS.map((candidate) =>
      candidate.fixtureId === fixture.id ? reference : candidate,
    );

    const invalid = gradeAnalysisOutputs(replacements);
    expect(invalid.fabricatedPrCitations).toBe(1);
    expect(invalid.passed).toBe(false);

    const pullRequest = fixture.input.pullRequests[0];
    output[fixture.focusMetric].evidence = [
      {
        prNumber: pullRequest.number,
        permalink: pullRequest.permalink,
        author: 'AnotherUser',
        sourceType: 'pull_request',
        targetRelation: 'target_authored_pr',
        quote: pullRequest.title,
        scoreRationale: '다른 사용자 활동을 잘못 귀속했습니다.',
      },
    ];
    const wrongUser = gradeAnalysisOutputs(replacements);
    expect(wrongUser.wrongUserAttributions).toBe(1);
    expect(wrongUser.passed).toBe(false);

    output[fixture.focusMetric].evidence = [];
    const bypass = gradeAnalysisOutputs(replacements);
    expect(bypass.evidenceGateFailures).toBe(1);
    expect(bypass.passed).toBe(false);
  });

  it('fails when any server-side evidence validation issue remains', () => {
    const reference = structuredClone(CHECKED_IN_REFERENCE_OUTPUTS[0]);
    const output = reference.output as Record<string, { reason: string }>;
    output.mutual_respect.reason = 'PR #999에서 확인했습니다.';
    const replacements = CHECKED_IN_REFERENCE_OUTPUTS.map((candidate) =>
      candidate.fixtureId === reference.fixtureId ? reference : candidate,
    );

    const summary = gradeAnalysisOutputs(replacements);
    expect(summary.evidenceValidationFailures).toBe(1);
    expect(summary.cases[0].evidencePassed).toBe(false);
    expect(summary.passed).toBe(false);
  });

  it('grades safe evidence issues without retaining a schema-valid model output', () => {
    const failedFixture = ANALYSIS_GOLDEN_FIXTURES[0];
    const outputs: AnalysisEvalInput[] = CHECKED_IN_REFERENCE_OUTPUTS.slice(
      1,
    ).map((candidate) => ({
      ...candidate,
    }));
    outputs.push({
      fixtureId: failedFixture.id,
      evidenceIssues: [
        {
          code: 'UNKNOWN_PR' as const,
          metric: failedFixture.focusMetric,
          evidenceIndex: 0,
        },
        {
          code: 'AUTHOR_MISMATCH' as const,
          metric: failedFixture.focusMetric,
          evidenceIndex: 1,
        },
      ],
    });

    const summary = gradeAnalysisOutputs(outputs);

    expect(summary.schemaPassedCases).toBe(24);
    expect(summary.scoreBandTotalLabels).toBe(192);
    expect(summary.fabricatedPrCitations).toBe(1);
    expect(summary.wrongUserAttributions).toBe(1);
    expect(summary.evidenceValidationFailures).toBe(1);
    expect(summary.missingOutputs).toBe(0);
    expect(summary.cases[0]).toMatchObject({
      schemaPassed: true,
      evidencePassed: false,
      matchingLabels: 0,
      totalLabels: 8,
      errorTypes: ['UNKNOWN_PR', 'AUTHOR_MISMATCH'],
    });
  });

  it('grades the legacy baseline with its original schema and deterministic PR citation checks', () => {
    const outputs = ANALYSIS_GOLDEN_FIXTURES.map((fixture) => {
      const metrics = Object.fromEntries(
        ANALYSIS_METRIC_KEYS.map((metric) => {
          const band = fixture.expectedScoreBands[metric];
          const needsEvidence = fixture.evidenceRequired.includes(metric);
          return [
            metric,
            {
              score: band.min,
              reason: needsEvidence
                ? `[PR #${fixture.input.pullRequests[0].number}](${fixture.input.pullRequests[0].permalink}) 합성 근거를 확인했습니다.`
                : '해당 역량은 중립 구간으로 평가했습니다.',
              improvement: '다음 검증 항목을 구체화합니다.',
              example: '검증 결과를 동료와 공유합니다.',
            },
          ];
        }),
      );
      return {
        fixtureId: fixture.id,
        output: { ...metrics, summary: '합성 baseline 평가입니다.' },
      };
    });

    const valid = gradeAnalysisOutputs(
      outputs,
      ANALYSIS_GOLDEN_FIXTURES,
      'legacy',
    );
    expect(valid).toMatchObject({
      schemaPassedCases: 24,
      scoreBandMatchingLabels: 192,
      fabricatedPrCitations: 0,
      wrongUserAttributions: 0,
      passed: true,
    });

    const forged = structuredClone(outputs);
    const forgedOutput = forged[0].output as Record<string, { reason: string }>;
    forgedOutput.mutual_respect.reason =
      '[PR #999](https://github.com/synthetic-org/quality-fixtures/pull/999) fabricated';
    const invalid = gradeAnalysisOutputs(
      forged,
      ANALYSIS_GOLDEN_FIXTURES,
      'legacy',
    );
    expect(invalid.fabricatedPrCitations).toBe(1);
    expect(invalid.passed).toBe(false);
  });
});
