import {
  ANALYSIS_METRIC_KEYS,
  LlmAnalysisResult,
  analysisResultSchema,
} from '../analysis-result.schema';
import { validateAnalysisEvidence } from '../evidence-validator';
import {
  ANALYSIS_GOLDEN_FIXTURES,
  AnalysisGoldenFixture,
  prepareGoldenFixtureInput,
} from './golden-fixtures';
import { CheckedInAnalysisOutput } from './reference-outputs';

export const ANALYSIS_EVAL_TOTAL_CASES = 24;
export const ANALYSIS_EVAL_TOTAL_LABELS = 192;
export const ANALYSIS_EVAL_MIN_AGREEMENT = 154;

export interface AnalysisEvalCaseResult {
  fixtureId: string;
  schemaPassed: boolean;
  evidencePassed: boolean;
  fabricatedCitationCount: number;
  wrongUserAttributionCount: number;
  evidenceGatePassed: boolean;
  matchingLabels: number;
  totalLabels: number;
  errorTypes: readonly string[];
}

export interface AnalysisEvalSummary {
  passed: boolean;
  totalCases: number;
  schemaPassedCases: number;
  schemaPassRate: number;
  fabricatedPrCitations: number;
  wrongUserAttributions: number;
  scoreBandMatchingLabels: number;
  scoreBandTotalLabels: number;
  scoreBandAgreement: number;
  evidenceValidationFailures: number;
  evidenceGateFailures: number;
  missingOutputs: number;
  cases: readonly AnalysisEvalCaseResult[];
}

export function gradeAnalysisOutputs(
  outputs: readonly CheckedInAnalysisOutput[],
  fixtures: readonly AnalysisGoldenFixture[] = ANALYSIS_GOLDEN_FIXTURES,
): AnalysisEvalSummary {
  if (fixtures.length !== ANALYSIS_EVAL_TOTAL_CASES) {
    throw new Error(
      `Expected ${ANALYSIS_EVAL_TOTAL_CASES} fixtures, received ${fixtures.length}.`,
    );
  }
  const outputsById = new Map(
    outputs.map((candidate) => [candidate.fixtureId, candidate.output]),
  );
  const cases = fixtures.map((fixture) =>
    gradeCase(fixture, outputsById.get(fixture.id)),
  );
  const schemaPassedCases = cases.filter((item) => item.schemaPassed).length;
  const fabricatedPrCitations = cases.reduce(
    (sum, item) => sum + item.fabricatedCitationCount,
    0,
  );
  const wrongUserAttributions = cases.reduce(
    (sum, item) => sum + item.wrongUserAttributionCount,
    0,
  );
  const scoreBandMatchingLabels = cases.reduce(
    (sum, item) => sum + item.matchingLabels,
    0,
  );
  const scoreBandTotalLabels = cases.reduce(
    (sum, item) => sum + item.totalLabels,
    0,
  );
  const evidenceValidationFailures = cases.filter(
    (item) => !item.evidencePassed,
  ).length;
  const evidenceGateFailures = cases.filter(
    (item) => !item.evidenceGatePassed,
  ).length;
  const missingOutputs = cases.filter((item) =>
    item.errorTypes.includes('MISSING_OUTPUT'),
  ).length;
  const summary = {
    totalCases: fixtures.length,
    schemaPassedCases,
    schemaPassRate: schemaPassedCases / ANALYSIS_EVAL_TOTAL_CASES,
    fabricatedPrCitations,
    wrongUserAttributions,
    scoreBandMatchingLabels,
    scoreBandTotalLabels,
    scoreBandAgreement: scoreBandMatchingLabels / ANALYSIS_EVAL_TOTAL_LABELS,
    evidenceValidationFailures,
    evidenceGateFailures,
    missingOutputs,
    cases,
  };
  return {
    ...summary,
    passed:
      summary.totalCases === ANALYSIS_EVAL_TOTAL_CASES &&
      summary.schemaPassedCases === ANALYSIS_EVAL_TOTAL_CASES &&
      summary.fabricatedPrCitations === 0 &&
      summary.wrongUserAttributions === 0 &&
      summary.scoreBandTotalLabels === ANALYSIS_EVAL_TOTAL_LABELS &&
      summary.scoreBandMatchingLabels >= ANALYSIS_EVAL_MIN_AGREEMENT &&
      summary.evidenceValidationFailures === 0 &&
      summary.evidenceGateFailures === 0 &&
      summary.missingOutputs === 0,
  };
}

function gradeCase(
  fixture: AnalysisGoldenFixture,
  output: unknown,
): AnalysisEvalCaseResult {
  if (output === undefined) {
    return failedCase(fixture.id, 'MISSING_OUTPUT');
  }
  const parsed = analysisResultSchema.safeParse(output);
  if (!parsed.success) {
    return failedCase(fixture.id, 'SCHEMA_INVALID');
  }
  const evidenceIssues = validateAnalysisEvidence(
    parsed.data,
    prepareGoldenFixtureInput(fixture.input),
  );
  const fabricatedPositions = uniqueEvidencePositions(
    evidenceIssues.filter(
      (issue) =>
        issue.code === 'UNKNOWN_PR' || issue.code === 'PERMALINK_MISMATCH',
    ),
  );
  const wrongUserPositions = uniqueEvidencePositions(
    evidenceIssues.filter(
      (issue) =>
        issue.code === 'AUTHOR_MISMATCH' || issue.code === 'QUOTE_NOT_OWNED',
    ),
  );
  const evidenceGatePassed = fixture.evidenceRequired.every(
    (metric) => parsed.data[metric].evidence.length > 0,
  );
  return {
    fixtureId: fixture.id,
    schemaPassed: true,
    evidencePassed: evidenceIssues.length === 0,
    fabricatedCitationCount: fabricatedPositions.size,
    wrongUserAttributionCount: wrongUserPositions.size,
    evidenceGatePassed,
    matchingLabels: countMatchingLabels(parsed.data, fixture),
    totalLabels: ANALYSIS_METRIC_KEYS.length,
    errorTypes: [
      ...new Set(evidenceIssues.map((issue) => issue.code)),
      ...(evidenceGatePassed ? [] : ['EVIDENCE_REQUIRED']),
    ],
  };
}

function countMatchingLabels(
  result: LlmAnalysisResult,
  fixture: AnalysisGoldenFixture,
): number {
  return ANALYSIS_METRIC_KEYS.filter((metric) => {
    const band = fixture.expectedScoreBands[metric];
    const score = result[metric].score;
    return score >= band.min && score <= band.max;
  }).length;
}

function uniqueEvidencePositions(
  issues: readonly {
    metric: string;
    evidenceIndex: number | null;
  }[],
): Set<string> {
  return new Set(
    issues.map(
      (issue) => `${issue.metric}:${issue.evidenceIndex ?? 'narrative'}`,
    ),
  );
}

function failedCase(
  fixtureId: string,
  errorType: string,
): AnalysisEvalCaseResult {
  return {
    fixtureId,
    schemaPassed: false,
    evidencePassed: false,
    fabricatedCitationCount: 0,
    wrongUserAttributionCount: 0,
    evidenceGatePassed: false,
    matchingLabels: 0,
    totalLabels: ANALYSIS_METRIC_KEYS.length,
    errorTypes: [errorType],
  };
}
