import { ANALYSIS_METRIC_KEYS } from '../analysis-result.schema';
import { ANALYSIS_GOLDEN_FIXTURES } from '../evals/golden-fixtures';
import {
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
        quote: 'Invented quote',
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
        quote: pullRequest.title,
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
});
