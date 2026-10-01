import { gradeAnalysisOutputs } from '../src/analysis/evals/grader';
import { ANALYSIS_GOLDEN_LABEL_REVIEW } from '../src/analysis/evals/golden-fixtures';
import { getAnalysisEvalIntegrity } from '../src/analysis/evals/integrity';
import {
  CHECKED_IN_REFERENCE_OUTPUTS,
  REFERENCE_OUTPUT_PROVENANCE,
} from '../src/analysis/evals/reference-outputs';

const summary = gradeAnalysisOutputs(CHECKED_IN_REFERENCE_OUTPUTS);
const integrity = getAnalysisEvalIntegrity();

console.table(
  summary.cases.map((item) => ({
    case: item.fixtureId,
    schema: item.schemaPassed ? 'pass' : 'fail',
    evidence: item.evidencePassed ? 'pass' : 'fail',
    fabricated: item.fabricatedCitationCount,
    wrongUser: item.wrongUserAttributionCount,
    unsupported: item.unsupportedClaimCount,
    evidenceGate: item.evidenceGatePassed ? 'pass' : 'fail',
    scoreBands: `${item.matchingLabels}/${item.totalLabels}`,
  })),
);
console.log(
  JSON.stringify(
    {
      kind: 'deterministic-analysis-eval',
      networkCalls: 0,
      labels: ANALYSIS_GOLDEN_LABEL_REVIEW,
      referenceOutputProvenance: REFERENCE_OUTPUT_PROVENANCE,
      qualityClaimEligible:
        ANALYSIS_GOLDEN_LABEL_REVIEW.status === 'approved',
      integrity,
      summary,
    },
    null,
    2,
  ),
);

if (!summary.passed || !integrity.passed) {
  process.exitCode = 1;
}
