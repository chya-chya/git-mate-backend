import { gradeAnalysisOutputs } from '../src/analysis/evals/grader';
import { CHECKED_IN_REFERENCE_OUTPUTS } from '../src/analysis/evals/reference-outputs';

const summary = gradeAnalysisOutputs(CHECKED_IN_REFERENCE_OUTPUTS);

console.table(
  summary.cases.map((item) => ({
    case: item.fixtureId,
    schema: item.schemaPassed ? 'pass' : 'fail',
    evidence: item.evidencePassed ? 'pass' : 'fail',
    fabricated: item.fabricatedCitationCount,
    wrongUser: item.wrongUserAttributionCount,
    evidenceGate: item.evidenceGatePassed ? 'pass' : 'fail',
    scoreBands: `${item.matchingLabels}/${item.totalLabels}`,
  })),
);
console.log(JSON.stringify(summary, null, 2));

if (!summary.passed) {
  process.exitCode = 1;
}
