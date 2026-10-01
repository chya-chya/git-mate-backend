import {
  ANALYSIS_METRIC_KEYS,
  LlmAnalysisResult,
} from '../analysis-result.schema';
import { ANALYSIS_GOLDEN_FIXTURES } from '../evals/golden-fixtures';
import { CHECKED_IN_REFERENCE_OUTPUTS } from '../evals/reference-outputs';
import {
  LiveEvalVariantRunner,
  assertLiveEvalOptIn,
  createLiveEvalDryRunReport,
  nearestRankP95,
  runLiveAnalysisEvaluation,
} from '../evals/live-eval';
import { InvalidLlmProviderResponseError } from '../llm-provider.service';

describe('live analysis baseline/candidate evaluation', () => {
  it.each([
    [{}, 'Live evaluation is disabled'],
    [{ RUN_LIVE_OPENAI_EVALS: 'false', OPENAI_API_KEY: 'secret' }, 'disabled'],
    [{ RUN_LIVE_OPENAI_EVALS: 'true' }, 'OPENAI_API_KEY'],
  ])('rejects missing double opt-in', (environment, message) => {
    expect(() => assertLiveEvalOptIn(environment, false)).toThrow(message);
  });

  it('allows explicit opt-in and key without changing the model', () => {
    expect(() =>
      assertLiveEvalOptIn(
        { RUN_LIVE_OPENAI_EVALS: 'true', OPENAI_API_KEY: 'secret' },
        false,
      ),
    ).not.toThrow();
  });

  it('plans exactly 48 sequential zero-retry calls in dry-run mode', () => {
    expect(() => assertLiveEvalOptIn({}, true)).not.toThrow();
    expect(createLiveEvalDryRunReport()).toMatchObject({
      executionStatus: 'not-run',
      apiCalls: 0,
      plannedApiCalls: 48,
      casesPerVariant: 24,
      requestedModel: 'gpt-5-mini',
      concurrency: 1,
      hiddenRetries: 0,
    });
  });

  it('compares all baseline and candidate cases without exposing credentials', async () => {
    let baselineIndex = 0;
    let candidateIndex = 0;
    const run = jest.fn((variant) => {
      if (variant === 'baseline') {
        const fixtureIndex = baselineIndex++;
        return Promise.resolve({
          providerRequestId: `chatcmpl_baseline_${fixtureIndex}`,
          requestedModel: 'gpt-5-mini',
          responseModel: 'gpt-5-mini-snapshot',
          promptVersion: 'analysis-v1',
          schemaVersion: null,
          generatedAt: '2026-09-28T00:00:00.000Z',
          usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
          output: makeLegacyOutput(fixtureIndex),
        });
      }

      const fixtureIndex = candidateIndex++;
      if (fixtureIndex === 0) {
        return Promise.reject(
          new InvalidLlmProviderResponseError(
            'chatcmpl_evidence_failure',
            { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
            'EVIDENCE_VALIDATION_FAILED',
            [
              {
                code: 'UNKNOWN_PR',
                metric: 'mutual_respect',
                evidenceIndex: 0,
              },
            ],
            'gpt-5-mini-snapshot',
          ),
        );
      }
      const referenceOutput = CHECKED_IN_REFERENCE_OUTPUTS[fixtureIndex]
        .output as LlmAnalysisResult;
      const output =
        fixtureIndex === 1
          ? {
              ...referenceOutput,
              mutual_respect: {
                ...referenceOutput.mutual_respect,
                evidence: [],
              },
            }
          : referenceOutput;
      return Promise.resolve({
        providerRequestId: `chatcmpl_candidate_${fixtureIndex}`,
        requestedModel: 'gpt-5-mini',
        responseModel: 'gpt-5-mini-snapshot',
        promptVersion: 'analysis-v3-structured-evidence-rationale',
        schemaVersion: output.metadata.schemaVersion,
        generatedAt: output.metadata.generatedAt,
        usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
        output,
      });
    });
    const runner: LiveEvalVariantRunner = { run };

    const report = await runLiveAnalysisEvaluation(
      {
        RUN_LIVE_OPENAI_EVALS: 'true',
        OPENAI_API_KEY: 'secret-not-for-artifact',
      },
      runner,
    );

    expect(report.callsAttempted).toBe(48);
    expect(report.executionRevision).toBe('local-working-tree');
    expect(report.baseline.summary).toMatchObject({
      schemaPassedCases: 24,
      scoreBandMatchingLabels: 192,
      fabricatedPrCitations: 0,
      wrongUserAttributions: 0,
    });
    expect(report.candidate.summary).toMatchObject({
      schemaPassedCases: 24,
      scoreBandTotalLabels: 192,
      fabricatedPrCitations: 1,
      evidenceValidationFailures: 1,
      evidenceGateFailures: 2,
      missingOutputs: 0,
    });
    expect(report.candidate.cases[0]).toMatchObject({
      errorType: 'EVIDENCE_VALIDATION_FAILED',
      responseModel: 'gpt-5-mini-snapshot',
      evidenceIssues: [
        {
          code: 'UNKNOWN_PR',
          metric: 'mutual_respect',
          evidenceIndex: 0,
        },
      ],
    });
    expect(report.comparison.criteria.labelsApproved).toBe(false);
    expect(report.comparison.criteria.candidateEvidenceValidationFailures).toBe(
      false,
    );
    expect(report.comparison.criteria.candidateEvidenceGateFailures).toBe(
      false,
    );
    expect(report.comparison.candidateAtLeastAsGoodCases).toBe(22);
    expect(report.comparison.passed).toBe(false);
    expect(JSON.stringify(report)).not.toContain('secret-not-for-artifact');
    expect(run).toHaveBeenCalledTimes(48);
  });

  it('uses nearest-rank p95 consistently', () => {
    expect(
      nearestRankP95(Array.from({ length: 24 }, (_, index) => index + 1)),
    ).toBe(23);
  });
});

function makeLegacyOutput(index: number): Record<string, unknown> {
  const fixture = ANALYSIS_GOLDEN_FIXTURES[index];
  const structured = CHECKED_IN_REFERENCE_OUTPUTS[index]
    .output as LlmAnalysisResult;
  const legacy: Record<string, unknown> = { summary: structured.summary };
  for (const key of ANALYSIS_METRIC_KEYS) {
    const metric = structured[key];
    const legacyMetric = {
      score: metric.score,
      reason: metric.reason,
      improvement: metric.improvement,
      example: metric.example,
    };
    legacy[key] =
      key === fixture.focusMetric &&
      fixture.evidenceContract[key].mustCite.length > 0
        ? {
            ...legacyMetric,
            reason: `${legacyMetric.reason} [PR #${fixture.input.pullRequests[0].number}](${fixture.input.pullRequests[0].permalink})`,
          }
        : legacyMetric;
  }
  return legacy;
}
