import {
  ANALYSIS_METRIC_KEYS,
  AnalysisEvidence,
  LlmAnalysisResult,
  analysisResultSchema,
} from '../analysis-result.schema';
import {
  EvidenceValidationIssue,
  normalizeEvidenceText,
  validateAnalysisEvidence,
} from '../evidence-validator';
import { z } from 'zod';
import {
  ANALYSIS_GOLDEN_FIXTURES,
  AllowedFixtureEvidence,
  AnalysisGoldenFixture,
  prepareGoldenFixtureInput,
} from './golden-fixtures';

export const ANALYSIS_EVAL_TOTAL_CASES = 24;
export const ANALYSIS_EVAL_TOTAL_LABELS = 192;
export const ANALYSIS_EVAL_MIN_AGREEMENT = 154;

export type AnalysisEvalOutputFormat = 'structured' | 'legacy';

const legacyMetricEvaluationSchema = z
  .object({
    score: z.number().finite().min(1).max(5).multipleOf(0.5),
    reason: z.string().trim().min(1),
    improvement: z.string().trim().min(1),
    example: z.string().trim().min(1),
  })
  .strict();

const legacyAnalysisResultSchema = z
  .object({
    mutual_respect: legacyMetricEvaluationSchema,
    conflict_management: legacyMetricEvaluationSchema,
    logical_problem_definition: legacyMetricEvaluationSchema,
    review_guiding: legacyMetricEvaluationSchema,
    documentation: legacyMetricEvaluationSchema,
    knowledge_sharing: legacyMetricEvaluationSchema,
    technical_influence: legacyMetricEvaluationSchema,
    code_stability: legacyMetricEvaluationSchema,
    summary: z.string().trim().min(1),
  })
  .strict();

type LegacyAnalysisResult = z.infer<typeof legacyAnalysisResultSchema>;

export interface AnalysisEvalCaseResult {
  fixtureId: string;
  schemaPassed: boolean;
  evidencePassed: boolean;
  fabricatedCitationCount: number;
  wrongUserAttributionCount: number;
  unsupportedClaimCount: number;
  evidenceGatePassed: boolean;
  matchingLabels: number;
  totalLabels: number;
  errorTypes: readonly string[];
}

export interface AnalysisEvalInput {
  fixtureId: string;
  output?: unknown;
  evidenceIssues?: readonly EvidenceValidationIssue[];
}

export interface AnalysisEvalSummary {
  passed: boolean;
  totalCases: number;
  schemaPassedCases: number;
  schemaPassRate: number;
  fabricatedPrCitations: number;
  wrongUserAttributions: number;
  unsupportedClaims: number;
  scoreBandMatchingLabels: number;
  scoreBandTotalLabels: number;
  scoreBandAgreement: number;
  evidenceValidationFailures: number;
  evidenceGateFailures: number;
  missingOutputs: number;
  cases: readonly AnalysisEvalCaseResult[];
}

export function gradeAnalysisOutputs(
  outputs: readonly AnalysisEvalInput[],
  fixtures: readonly AnalysisGoldenFixture[] = ANALYSIS_GOLDEN_FIXTURES,
  outputFormat: AnalysisEvalOutputFormat = 'structured',
): AnalysisEvalSummary {
  if (fixtures.length !== ANALYSIS_EVAL_TOTAL_CASES) {
    throw new Error(
      `Expected ${ANALYSIS_EVAL_TOTAL_CASES} fixtures, received ${fixtures.length}.`,
    );
  }
  const outputsById = new Map(
    outputs.map((candidate) => [candidate.fixtureId, candidate]),
  );
  const cases = fixtures.map((fixture) =>
    gradeCase(fixture, outputsById.get(fixture.id), outputFormat),
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
  const unsupportedClaims = cases.reduce(
    (sum, item) => sum + item.unsupportedClaimCount,
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
    unsupportedClaims,
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
      summary.unsupportedClaims === 0 &&
      summary.scoreBandTotalLabels === ANALYSIS_EVAL_TOTAL_LABELS &&
      summary.scoreBandMatchingLabels >= ANALYSIS_EVAL_MIN_AGREEMENT &&
      summary.evidenceValidationFailures === 0 &&
      summary.evidenceGateFailures === 0 &&
      summary.missingOutputs === 0,
  };
}

function gradeCase(
  fixture: AnalysisGoldenFixture,
  candidate: AnalysisEvalInput | undefined,
  outputFormat: AnalysisEvalOutputFormat,
): AnalysisEvalCaseResult {
  if (candidate === undefined) {
    return failedCase(fixture.id, 'MISSING_OUTPUT');
  }
  if (candidate.evidenceIssues !== undefined) {
    return failedEvidenceCase(fixture.id, candidate.evidenceIssues);
  }
  if (candidate.output === undefined) {
    return failedCase(fixture.id, 'MISSING_OUTPUT');
  }
  if (outputFormat === 'legacy') {
    return gradeLegacyCase(fixture, candidate.output);
  }
  const parsed = analysisResultSchema.safeParse(candidate.output);
  if (!parsed.success) {
    return failedCase(fixture.id, 'SCHEMA_INVALID');
  }
  const evidenceIssues = validateAnalysisEvidence(
    parsed.data,
    prepareGoldenFixtureInput(fixture.input),
  );
  const { fabricatedCitationCount, wrongUserAttributionCount } =
    countEvidenceFailures(evidenceIssues);
  const unsupportedClaimCount = countUnsupportedClaims(evidenceIssues);
  const fixtureEvidenceErrors = validateStructuredFixtureEvidence(
    parsed.data,
    fixture,
  );
  const evidenceGatePassed = fixtureEvidenceErrors.length === 0;
  return {
    fixtureId: fixture.id,
    schemaPassed: true,
    evidencePassed: evidenceIssues.length === 0,
    fabricatedCitationCount,
    wrongUserAttributionCount,
    unsupportedClaimCount,
    evidenceGatePassed,
    matchingLabels: countMatchingLabels(parsed.data, fixture),
    totalLabels: ANALYSIS_METRIC_KEYS.length,
    errorTypes: [
      ...new Set(evidenceIssues.map((issue) => issue.code)),
      ...fixtureEvidenceErrors,
    ],
  };
}

function gradeLegacyCase(
  fixture: AnalysisGoldenFixture,
  output: unknown,
): AnalysisEvalCaseResult {
  const parsed = legacyAnalysisResultSchema.safeParse(output);
  if (!parsed.success) {
    return failedCase(fixture.id, 'SCHEMA_INVALID');
  }

  const errorTypes = new Set<string>();
  let fabricatedCitationCount = 0;
  let wrongUserAttributionCount = 0;
  let unsupportedClaimCount = 0;
  const citationsByMetric = new Map<string, readonly LegacyCitation[]>();

  for (const metric of ANALYSIS_METRIC_KEYS) {
    const evaluation = parsed.data[metric];
    const citations = extractLegacyCitations(
      [evaluation.reason, evaluation.improvement, evaluation.example].join(
        '\n',
      ),
    );
    citationsByMetric.set(metric, citations);
    let hasValidCitation = false;
    for (const citation of citations) {
      const pullRequest = fixture.input.pullRequests.find(
        (candidate) => candidate.number === citation.prNumber,
      );
      if (
        !pullRequest ||
        (citation.permalink !== null &&
          citation.permalink.toLowerCase() !==
            pullRequest.permalink.toLowerCase())
      ) {
        fabricatedCitationCount += 1;
        errorTypes.add('UNKNOWN_PR');
        continue;
      }
      if (!hasTargetActivity(pullRequest, fixture.input.targetUser)) {
        wrongUserAttributionCount += 1;
        errorTypes.add('AUTHOR_MISMATCH');
        continue;
      }
      hasValidCitation = true;
    }
    if (
      !hasValidCitation &&
      evaluation.score !== 3 &&
      evaluation.score !== 3.5
    ) {
      unsupportedClaimCount += 1;
      errorTypes.add('UNSUPPORTED_SCORE_WITHOUT_EVIDENCE');
    }
  }

  const fixtureEvidenceErrors = validateLegacyFixtureEvidence(
    fixture,
    citationsByMetric,
  );
  const evidenceGatePassed = fixtureEvidenceErrors.length === 0;
  for (const fixtureEvidenceError of fixtureEvidenceErrors) {
    errorTypes.add(fixtureEvidenceError);
  }
  const evidencePassed =
    fabricatedCitationCount === 0 &&
    wrongUserAttributionCount === 0 &&
    unsupportedClaimCount === 0;
  return {
    fixtureId: fixture.id,
    schemaPassed: true,
    evidencePassed,
    fabricatedCitationCount,
    wrongUserAttributionCount,
    unsupportedClaimCount,
    evidenceGatePassed,
    matchingLabels: countMatchingLabels(parsed.data, fixture),
    totalLabels: ANALYSIS_METRIC_KEYS.length,
    errorTypes: [...errorTypes],
  };
}

function extractLegacyCitations(reason: string): readonly LegacyCitation[] {
  const citations = new Map<
    number,
    { prNumber: number; permalink: string | null }
  >();
  const permalinkPattern =
    /https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+\/pull\/([1-9]\d*)/giu;
  for (const match of reason.matchAll(permalinkPattern)) {
    const prNumber = Number(match[1]);
    citations.set(prNumber, {
      prNumber,
      permalink: match[0],
    });
  }
  const numberPattern = /\bPR\s*#([1-9]\d*)\b/giu;
  for (const match of reason.matchAll(numberPattern)) {
    const prNumber = Number(match[1]);
    if (!citations.has(prNumber)) {
      citations.set(prNumber, { prNumber, permalink: null });
    }
  }
  return [...citations.values()];
}

interface LegacyCitation {
  prNumber: number;
  permalink: string | null;
}

function validateStructuredFixtureEvidence(
  result: LlmAnalysisResult,
  fixture: AnalysisGoldenFixture,
): readonly string[] {
  const errors = new Set<string>();
  for (const metric of ANALYSIS_METRIC_KEYS) {
    const contract = fixture.evidenceContract[metric];
    const evidence = result[metric].evidence;
    if (
      contract.mustCite.length > 0 &&
      !evidence.some((item) =>
        contract.mustCite.some((required) =>
          matchesRequiredStructuredEvidence(item, required),
        ),
      )
    ) {
      errors.add('FIXTURE_REQUIRED_EVIDENCE_MISSING');
    }
    if (
      evidence.some((item) =>
        contract.mustNotCite.some((forbidden) =>
          matchesStructuredEvidenceActivity(item, forbidden),
        ),
      )
    ) {
      errors.add('FIXTURE_FORBIDDEN_EVIDENCE');
    }
  }
  return [...errors];
}

function matchesStructuredEvidenceActivity(
  actual: AnalysisEvidence,
  expected: AllowedFixtureEvidence,
): boolean {
  return (
    actual.prNumber === expected.prNumber &&
    actual.permalink === expected.permalink &&
    actual.author.toLocaleLowerCase('en-US') ===
      expected.author.toLocaleLowerCase('en-US') &&
    actual.sourceType === expected.sourceType &&
    actual.targetRelation === expected.targetRelation
  );
}

function matchesRequiredStructuredEvidence(
  actual: AnalysisEvidence,
  expected: AllowedFixtureEvidence,
): boolean {
  return (
    matchesStructuredEvidenceActivity(actual, expected) &&
    normalizeEvidenceText(actual.quote) ===
      normalizeEvidenceText(expected.quote)
  );
}

function validateLegacyFixtureEvidence(
  fixture: AnalysisGoldenFixture,
  citationsByMetric: ReadonlyMap<string, readonly LegacyCitation[]>,
): readonly string[] {
  const errors = new Set<string>();
  for (const metric of ANALYSIS_METRIC_KEYS) {
    const contract = fixture.evidenceContract[metric];
    const citations = citationsByMetric.get(metric) ?? [];
    if (
      contract.mustCite.length > 0 &&
      !citations.some((citation) =>
        contract.mustCite.some((required) =>
          matchesRequiredLegacyEvidence(citation, required),
        ),
      )
    ) {
      errors.add('FIXTURE_REQUIRED_EVIDENCE_MISSING');
    }
    if (
      citations.some((citation) =>
        contract.mustNotCite.some(
          (forbidden) => citation.prNumber === forbidden.prNumber,
        ),
      )
    ) {
      errors.add('FIXTURE_FORBIDDEN_EVIDENCE');
    }
  }
  return [...errors];
}

function matchesRequiredLegacyEvidence(
  citation: LegacyCitation,
  expected: AllowedFixtureEvidence,
): boolean {
  return (
    citation.prNumber === expected.prNumber &&
    citation.permalink?.toLocaleLowerCase('en-US') ===
      expected.permalink.toLocaleLowerCase('en-US')
  );
}

function hasTargetActivity(
  pullRequest: AnalysisGoldenFixture['input']['pullRequests'][number],
  targetUser: string,
): boolean {
  const normalizedTarget = targetUser.toLowerCase();
  return (
    pullRequest.author.toLowerCase() === normalizedTarget ||
    pullRequest.reviews.some(
      (review) =>
        review.author.toLowerCase() === normalizedTarget ||
        review.comments.some(
          (comment) => comment.author.toLowerCase() === normalizedTarget,
        ),
    )
  );
}

function failedEvidenceCase(
  fixtureId: string,
  evidenceIssues: readonly EvidenceValidationIssue[],
): AnalysisEvalCaseResult {
  const { fabricatedCitationCount, wrongUserAttributionCount } =
    countEvidenceFailures(evidenceIssues);
  return {
    fixtureId,
    schemaPassed: true,
    evidencePassed: false,
    fabricatedCitationCount,
    wrongUserAttributionCount,
    unsupportedClaimCount: countUnsupportedClaims(evidenceIssues),
    evidenceGatePassed: false,
    matchingLabels: 0,
    totalLabels: ANALYSIS_METRIC_KEYS.length,
    errorTypes: [...new Set(evidenceIssues.map((issue) => issue.code))],
  };
}

function countEvidenceFailures(
  evidenceIssues: readonly EvidenceValidationIssue[],
): Pick<
  AnalysisEvalCaseResult,
  'fabricatedCitationCount' | 'wrongUserAttributionCount'
> {
  const fabricatedPositions = uniqueEvidencePositions(
    evidenceIssues.filter(
      (issue) =>
        issue.code === 'UNKNOWN_PR' || issue.code === 'PERMALINK_MISMATCH',
    ),
  );
  const wrongUserPositions = uniqueEvidencePositions(
    evidenceIssues.filter(
      (issue) =>
        issue.code === 'AUTHOR_MISMATCH' ||
        issue.code === 'QUOTE_NOT_OWNED' ||
        issue.code === 'SOURCE_RELATION_MISMATCH',
    ),
  );
  return {
    fabricatedCitationCount: fabricatedPositions.size,
    wrongUserAttributionCount: wrongUserPositions.size,
  };
}

function countUnsupportedClaims(
  evidenceIssues: readonly EvidenceValidationIssue[],
): number {
  return evidenceIssues.filter(
    (issue) => issue.code === 'UNSUPPORTED_SCORE_WITHOUT_EVIDENCE',
  ).length;
}

function countMatchingLabels(
  result: LlmAnalysisResult | LegacyAnalysisResult,
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
    unsupportedClaimCount: 0,
    evidenceGatePassed: false,
    matchingLabels: 0,
    totalLabels: ANALYSIS_METRIC_KEYS.length,
    errorTypes: [errorType],
  };
}
