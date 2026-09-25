import { LlmAnalysisResult } from '../analysis-result.schema';
import { CHECKED_IN_REFERENCE_OUTPUTS } from '../evals/reference-outputs';
import {
  assertLiveEvalOptIn,
  runLiveAnalysisEvaluation,
} from '../evals/live-eval';
import {
  InvalidLlmProviderResponseError,
  LlmProviderService,
} from '../llm-provider.service';

describe('live analysis evaluation guard', () => {
  it.each([
    [{}, 'Live evaluation is disabled'],
    [{ RUN_LIVE_OPENAI_EVALS: 'false', OPENAI_API_KEY: 'secret' }, 'disabled'],
    [{ RUN_LIVE_OPENAI_EVALS: 'true' }, 'OPENAI_API_KEY'],
  ])('rejects missing double opt-in', (environment, message) => {
    expect(() => assertLiveEvalOptIn(environment, false)).toThrow(message);
  });

  it('allows explicit opt-in and key without exposing or changing the model', () => {
    expect(() =>
      assertLiveEvalOptIn(
        { RUN_LIVE_OPENAI_EVALS: 'true', OPENAI_API_KEY: 'secret' },
        false,
      ),
    ).not.toThrow();
  });

  it('allows a zero-call dry run without credentials', () => {
    expect(() => assertLiveEvalOptIn({}, true)).not.toThrow();
  });

  it('reports safe evidence issues without persisting the rejected model output', async () => {
    let callIndex = 0;
    const analyze = jest
      .spyOn(LlmProviderService.prototype, 'analyze')
      .mockImplementation(() => {
        const fixtureIndex = callIndex++;
        if (fixtureIndex === 0) {
          return Promise.reject(
            new InvalidLlmProviderResponseError(
              'chatcmpl_evidence_failure',
              { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
              'EVIDENCE_VALIDATION_FAILED',
              [
                {
                  code: 'UNKNOWN_PR',
                  metric: 'mutual_respect',
                  evidenceIndex: 0,
                },
              ],
            ),
          );
        }
        return Promise.resolve({
          providerRequestId: `chatcmpl_${fixtureIndex}`,
          requestedModel: 'gpt-5-mini',
          responseModel: 'gpt-5-mini',
          promptVersion: 'analysis-v2-structured-evidence',
          result: CHECKED_IN_REFERENCE_OUTPUTS[fixtureIndex]
            .output as LlmAnalysisResult,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });
      });

    try {
      const report = await runLiveAnalysisEvaluation({
        RUN_LIVE_OPENAI_EVALS: 'true',
        OPENAI_API_KEY: 'secret-not-for-artifact',
      });

      expect(report.summary).toMatchObject({
        schemaPassedCases: 24,
        scoreBandTotalLabels: 192,
        fabricatedPrCitations: 1,
        evidenceValidationFailures: 1,
        missingOutputs: 0,
      });
      expect(report.cases[0]).toMatchObject({
        errorType: 'EVIDENCE_VALIDATION_FAILED',
        evidenceIssues: [
          {
            code: 'UNKNOWN_PR',
            metric: 'mutual_respect',
            evidenceIndex: 0,
          },
        ],
      });
      expect(JSON.stringify(report)).not.toContain('secret-not-for-artifact');
      expect(analyze).toHaveBeenCalledTimes(24);
    } finally {
      analyze.mockRestore();
    }
  });
});
