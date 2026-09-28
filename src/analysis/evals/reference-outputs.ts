import {
  ANALYSIS_METRIC_KEYS,
  LlmAnalysisResult,
} from '../analysis-result.schema';
import { ANALYSIS_GOLDEN_FIXTURES } from './golden-fixtures';

export interface CheckedInAnalysisOutput {
  fixtureId: string;
  output: unknown;
}

export const CHECKED_IN_REFERENCE_OUTPUTS: readonly CheckedInAnalysisOutput[] =
  ANALYSIS_GOLDEN_FIXTURES.map((fixture) => {
    const pullRequest = fixture.input.pullRequests[0];
    const evidence = findTargetEvidence(fixture.input);
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
            fixture.evidenceRequired.includes(metric) &&
            evidence !== null
              ? [
                  {
                    prNumber: pullRequest.number,
                    permalink: pullRequest.permalink,
                    author: fixture.input.targetUser,
                    quote: evidence,
                  },
                ]
              : [],
        },
      ]),
    ) as Omit<LlmAnalysisResult, 'summary'>;
    return {
      fixtureId: fixture.id,
      output: {
        ...output,
        summary:
          '합성 데이터만으로 평가했으며 직접 근거가 있는 행동과 근거가 부족한 지표를 분리했습니다.',
      } satisfies LlmAnalysisResult,
    };
  });

function findTargetEvidence(
  input: (typeof ANALYSIS_GOLDEN_FIXTURES)[number]['input'],
): string | null {
  const target = input.targetUser.toLocaleLowerCase('en-US');
  const pullRequest = input.pullRequests[0];
  if (pullRequest.author.toLocaleLowerCase('en-US') === target) {
    return pullRequest.title;
  }
  for (const review of pullRequest.reviews) {
    if (review.author.toLocaleLowerCase('en-US') === target) {
      return review.body;
    }
    const comment = review.comments.find(
      (candidate) => candidate.author.toLocaleLowerCase('en-US') === target,
    );
    if (comment) {
      return comment.body;
    }
  }
  return null;
}
