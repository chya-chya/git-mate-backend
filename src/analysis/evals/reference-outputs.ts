import {
  ANALYSIS_RESULT_SCHEMA_VERSION,
  ANALYSIS_METRIC_KEYS,
  LlmAnalysisResult,
} from '../analysis-result.schema';
import {
  ANALYSIS_MODEL_VERSION,
  ANALYSIS_PROMPT_VERSION,
} from '../analysis-execution-version';
import { ANALYSIS_GOLDEN_FIXTURES } from './golden-fixtures';

export interface CheckedInAnalysisOutput {
  fixtureId: string;
  output: unknown;
}

export const REFERENCE_OUTPUT_PROVENANCE = Object.freeze({
  kind: 'human-authored-evaluation-reference' as const,
  version: 'analysis-reference-output-v3',
  createdAt: '2026-09-28T00:00:00.000Z',
  modelExecuted: false,
  description:
    'Deterministic fixture references authored for grader regression; not OpenAI output.',
});

export const CHECKED_IN_REFERENCE_OUTPUTS: readonly CheckedInAnalysisOutput[] =
  ANALYSIS_GOLDEN_FIXTURES.map((fixture) => {
    const requiredEvidence =
      fixture.evidenceContract[fixture.focusMetric].mustCite[0] ?? null;
    const scores = {
      high: 4.5,
      medium: 3.5,
      low: 2,
    } as const;
    const output = Object.fromEntries(
      ANALYSIS_METRIC_KEYS.map((metric) => [
        metric,
        {
          score: metric === fixture.focusMetric ? scores[fixture.level] : 3,
          reason:
            metric === fixture.focusMetric
              ? '합성 활동에서 해당 지표의 행동 수준을 직접 확인했습니다.'
              : '이 지표를 구분할 직접 근거가 제한되어 기본 구간으로 평가했습니다.',
          improvement:
            '측정 가능한 검증 기준과 의사결정 기록을 보강해야 합니다.',
          example:
            '변경의 전제와 측정 결과, 실패 시 되돌림 기준을 함께 검토해 주세요.',
          evidence:
            metric === fixture.focusMetric &&
            fixture.evidenceContract[metric].mustCite.length > 0 &&
            requiredEvidence !== null
              ? [
                  {
                    prNumber: requiredEvidence.prNumber,
                    permalink: requiredEvidence.permalink,
                    author: requiredEvidence.author,
                    sourceType: requiredEvidence.sourceType,
                    targetRelation: requiredEvidence.targetRelation,
                    quote: requiredEvidence.quote,
                    scoreRationale:
                      '합성 원문이 해당 역량의 기대 행동 수준을 직접 보여 줍니다.',
                  },
                ]
              : [],
        },
      ]),
    ) as Omit<LlmAnalysisResult, 'summary' | 'metadata'>;
    return {
      fixtureId: fixture.id,
      output: {
        ...output,
        summary:
          '합성 데이터만으로 평가했으며 직접 근거가 있는 행동과 근거가 부족한 지표를 분리했습니다.',
        metadata: {
          requestedModel: ANALYSIS_MODEL_VERSION,
          responseModel: 'human-authored-reference',
          promptVersion: ANALYSIS_PROMPT_VERSION,
          schemaVersion: ANALYSIS_RESULT_SCHEMA_VERSION,
          generatedAt: REFERENCE_OUTPUT_PROVENANCE.createdAt,
        },
      } satisfies LlmAnalysisResult,
    };
  });
