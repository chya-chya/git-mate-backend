import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { CollectedDataDto } from '../../collection/types/github-api.types';
import { ANALYSIS_MODEL_VERSION } from '../analysis-execution-version';
import { ANALYSIS_RESULT_SCHEMA_VERSION } from '../analysis-result.schema';
import { EvidenceValidationIssue } from '../evidence-validator';
import {
  LlmProviderReconciliationError,
  LlmProviderService,
  LlmTokenUsage,
  MAX_ANALYSIS_COMPLETION_TOKENS,
} from '../llm-provider.service';
import {
  ANALYSIS_GOLDEN_FIXTURES,
  ANALYSIS_GOLDEN_LABEL_REVIEW,
  prepareGoldenFixtureInput,
} from './golden-fixtures';
import {
  ANALYSIS_EVAL_MIN_AGREEMENT,
  AnalysisEvalCaseResult,
  AnalysisEvalInput,
  AnalysisEvalSummary,
  gradeAnalysisOutputs,
} from './grader';
import {
  ANALYSIS_LIVE_EVAL_CASES_PER_VARIANT,
  ANALYSIS_LIVE_EVAL_MAX_CALLS,
  ANALYSIS_LIVE_EVAL_REQUEST_TIMEOUT_MS,
  ANALYSIS_PROMPT_MANIFESTS,
  AnalysisPromptManifest,
  AnalysisPromptVariant,
  buildVariantMessages,
} from './prompt-variants';

export interface LiveEvalCaseMetadata {
  fixtureId: string;
  variant: AnalysisPromptVariant;
  providerRequestId: string | null;
  requestedModel: string;
  responseModel: string | null;
  promptVersion: string;
  schemaVersion: string | null;
  generatedAt: string;
  latencyMs: number;
  usage: LlmTokenUsage | null;
  errorType: string | null;
  evidenceIssues: readonly EvidenceValidationIssue[];
  output: unknown;
}

export interface LiveEvalVariantReport {
  variant: AnalysisPromptVariant;
  prompt: AnalysisPromptManifest;
  summary: AnalysisEvalSummary;
  averageTotalTokens: number | null;
  nearestRankP95LatencyMs: number;
  usageComplete: boolean;
  cases: readonly LiveEvalCaseMetadata[];
}

export interface LiveEvalComparison {
  candidateAtLeastAsGoodCases: number;
  requiredCandidateAtLeastAsGoodCases: number;
  totalCases: number;
  averageTotalTokenRatio: number | null;
  nearestRankP95LatencyRatio: number | null;
  criteria: {
    labelsApproved: boolean;
    candidateSchemaPassRate: boolean;
    candidateFabricatedPrCitations: boolean;
    candidateWrongUserAttributions: boolean;
    candidateUnsupportedClaims: boolean;
    candidateEvidenceValidationFailures: boolean;
    candidateEvidenceGateFailures: boolean;
    candidateScoreBandAgreement: boolean;
    candidateAtLeastAsGoodCases: boolean;
    averageTotalTokensWithinTwentyPercent: boolean;
    nearestRankP95LatencyWithinTwentyPercent: boolean;
  };
  passed: boolean;
}

export interface LiveEvalReport {
  kind: 'live-openai-analysis-baseline-candidate-eval';
  executedAt: string;
  executionRevision: string;
  executionStatus: 'completed';
  requestedModel: typeof ANALYSIS_MODEL_VERSION;
  callsAttempted: number;
  maximumCalls: typeof ANALYSIS_LIVE_EVAL_MAX_CALLS;
  concurrency: 1;
  hiddenRetries: 0;
  requestTimeoutMs: typeof ANALYSIS_LIVE_EVAL_REQUEST_TIMEOUT_MS;
  labelReview: typeof ANALYSIS_GOLDEN_LABEL_REVIEW;
  baseline: LiveEvalVariantReport;
  candidate: LiveEvalVariantReport;
  comparison: LiveEvalComparison;
}

export interface LiveEvalVariantRunResult {
  providerRequestId: string;
  requestedModel: string;
  responseModel: string;
  promptVersion: string;
  schemaVersion: string | null;
  generatedAt: string;
  usage: LlmTokenUsage;
  output: unknown;
}

export interface LiveEvalVariantRunner {
  run(
    variant: AnalysisPromptVariant,
    data: CollectedDataDto,
  ): Promise<LiveEvalVariantRunResult>;
}

export function assertLiveEvalOptIn(
  environment: NodeJS.ProcessEnv,
  dryRun: boolean,
): void {
  if (dryRun) {
    return;
  }
  if (environment.RUN_LIVE_OPENAI_EVALS !== 'true') {
    throw new Error(
      'Live evaluation is disabled. Set RUN_LIVE_OPENAI_EVALS=true to opt in.',
    );
  }
  if (!environment.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for live evaluation.');
  }
}

export async function runLiveAnalysisEvaluation(
  environment: NodeJS.ProcessEnv,
  runner: LiveEvalVariantRunner = new OpenAiLiveEvalVariantRunner(environment),
): Promise<LiveEvalReport> {
  assertLiveEvalOptIn(environment, false);
  const baseline = await runVariant('baseline', runner);
  const candidate = await runVariant('candidate', runner);
  const callsAttempted = baseline.cases.length + candidate.cases.length;
  if (callsAttempted > ANALYSIS_LIVE_EVAL_MAX_CALLS) {
    throw new Error('Live evaluation exceeded the 48-call safety limit.');
  }
  return {
    kind: 'live-openai-analysis-baseline-candidate-eval',
    executedAt: new Date().toISOString(),
    executionRevision: resolveExecutionRevision(environment),
    executionStatus: 'completed',
    requestedModel: ANALYSIS_MODEL_VERSION,
    callsAttempted,
    maximumCalls: ANALYSIS_LIVE_EVAL_MAX_CALLS,
    concurrency: 1,
    hiddenRetries: 0,
    requestTimeoutMs: ANALYSIS_LIVE_EVAL_REQUEST_TIMEOUT_MS,
    labelReview: ANALYSIS_GOLDEN_LABEL_REVIEW,
    baseline,
    candidate,
    comparison: compareVariants(baseline, candidate),
  };
}

export function createLiveEvalDryRunReport(): Record<string, unknown> {
  return {
    kind: 'live-openai-analysis-baseline-candidate-eval',
    executionStatus: 'not-run',
    executionRevision: resolveExecutionRevision(process.env),
    reason: 'dry-run',
    apiCalls: 0,
    plannedApiCalls: ANALYSIS_LIVE_EVAL_MAX_CALLS,
    casesPerVariant: ANALYSIS_LIVE_EVAL_CASES_PER_VARIANT,
    requestedModel: ANALYSIS_MODEL_VERSION,
    concurrency: 1,
    hiddenRetries: 0,
    requestTimeoutMs: ANALYSIS_LIVE_EVAL_REQUEST_TIMEOUT_MS,
    labelReview: ANALYSIS_GOLDEN_LABEL_REVIEW,
    prompts: ANALYSIS_PROMPT_MANIFESTS,
  };
}

function resolveExecutionRevision(environment: NodeJS.ProcessEnv): string {
  return (
    environment.GITHUB_SHA ??
    environment.ANALYSIS_EVAL_SOURCE_REVISION ??
    'local-working-tree'
  );
}

export function renderLiveEvalMarkdown(report: LiveEvalReport): string {
  const comparison = report.comparison;
  const rows = [
    metricRow(
      'Schema pass',
      `${report.baseline.summary.schemaPassedCases}/24`,
      `${report.candidate.summary.schemaPassedCases}/24`,
    ),
    metricRow(
      'Fabricated PR citations',
      report.baseline.summary.fabricatedPrCitations,
      report.candidate.summary.fabricatedPrCitations,
    ),
    metricRow(
      'Wrong-user attributions',
      report.baseline.summary.wrongUserAttributions,
      report.candidate.summary.wrongUserAttributions,
    ),
    metricRow(
      'Unsupported claims',
      report.baseline.summary.unsupportedClaims,
      report.candidate.summary.unsupportedClaims,
    ),
    metricRow(
      'Evidence validation failures',
      report.baseline.summary.evidenceValidationFailures,
      report.candidate.summary.evidenceValidationFailures,
    ),
    metricRow(
      'Evidence gate failures',
      report.baseline.summary.evidenceGateFailures,
      report.candidate.summary.evidenceGateFailures,
    ),
    metricRow(
      'Score-band agreement',
      `${report.baseline.summary.scoreBandMatchingLabels}/192`,
      `${report.candidate.summary.scoreBandMatchingLabels}/192`,
    ),
    metricRow(
      'Average total tokens',
      report.baseline.averageTotalTokens ?? 'unavailable',
      report.candidate.averageTotalTokens ?? 'unavailable',
    ),
    metricRow(
      'Nearest-rank p95 latency (ms)',
      report.baseline.nearestRankP95LatencyMs,
      report.candidate.nearestRankP95LatencyMs,
    ),
  ];
  return [
    '# Analysis baseline/candidate evaluation',
    '',
    `- Executed at: ${report.executedAt}`,
    `- Execution revision: ${report.executionRevision}`,
    `- Model: ${report.requestedModel}`,
    `- Calls: ${report.callsAttempted}/${report.maximumCalls}`,
    `- Label approval: ${report.labelReview.status} (${report.labelReview.version})`,
    `- Overall quality gate: ${comparison.passed ? 'PASS' : 'FAIL'}`,
    '',
    '| Metric | Baseline | Candidate |',
    '| --- | ---: | ---: |',
    ...rows,
    '',
    `Candidate >= baseline: ${comparison.candidateAtLeastAsGoodCases}/${comparison.totalCases} (required ${comparison.requiredCandidateAtLeastAsGoodCases})`,
    `Average token ratio: ${formatRatio(comparison.averageTotalTokenRatio)}`,
    `Nearest-rank p95 latency ratio: ${formatRatio(comparison.nearestRankP95LatencyRatio)}`,
    '',
    '## Prompt manifests',
    '',
    `- Baseline: ${report.baseline.prompt.promptVersion} / ${report.baseline.prompt.checksumSha256}`,
    `- Candidate: ${report.candidate.prompt.promptVersion} / ${report.candidate.prompt.checksumSha256}`,
    '',
    'The JSON report contains the complete prompt templates and per-case synthetic outputs. No production GitHub data is used.',
    '',
  ].join('\n');
}

class OpenAiLiveEvalVariantRunner implements LiveEvalVariantRunner {
  private readonly baselineClient: OpenAI;
  private readonly candidateProvider: LlmProviderService;

  constructor(environment: NodeJS.ProcessEnv) {
    const apiKey = environment.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for live evaluation.');
    }
    this.baselineClient = new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: ANALYSIS_LIVE_EVAL_REQUEST_TIMEOUT_MS,
    });
    this.candidateProvider = new LlmProviderService(
      new ConfigService({
        OPENAI_API_KEY: apiKey,
        OPENAI_TIMEOUT_MS: String(ANALYSIS_LIVE_EVAL_REQUEST_TIMEOUT_MS),
      }),
    );
  }

  run(
    variant: AnalysisPromptVariant,
    data: CollectedDataDto,
  ): Promise<LiveEvalVariantRunResult> {
    return variant === 'baseline'
      ? this.runBaseline(data)
      : this.runCandidate(data);
  }

  private async runCandidate(
    data: CollectedDataDto,
  ): Promise<LiveEvalVariantRunResult> {
    const response = await this.candidateProvider.analyze(data);
    return {
      providerRequestId: response.providerRequestId,
      requestedModel: response.requestedModel,
      responseModel: response.responseModel,
      promptVersion: response.promptVersion,
      schemaVersion: response.result.metadata.schemaVersion,
      generatedAt: response.result.metadata.generatedAt,
      usage: response.usage,
      output: response.result,
    };
  }

  private async runBaseline(
    data: CollectedDataDto,
  ): Promise<LiveEvalVariantRunResult> {
    const response = await this.baselineClient.chat.completions.create({
      model: ANALYSIS_MODEL_VERSION,
      messages: buildVariantMessages('baseline', data),
      max_completion_tokens: MAX_ANALYSIS_COMPLETION_TOKENS,
      response_format: { type: 'json_object' },
    });
    const usage = normalizeUsage(response.usage);
    const choice = response.choices.at(0);
    if (!choice || !usage || typeof response.id !== 'string') {
      throw new LiveEvalCallError(
        typeof response.id === 'string' ? response.id : null,
        usage,
        typeof response.model === 'string' ? response.model : null,
        'INVALID_BASELINE_RESPONSE',
      );
    }
    if (choice.finish_reason !== 'stop' || !choice.message.content) {
      throw new LiveEvalCallError(
        response.id,
        usage,
        response.model,
        `INCOMPLETE_${String(choice.finish_reason).toUpperCase()}`,
      );
    }
    let output: unknown;
    try {
      output = JSON.parse(choice.message.content);
    } catch {
      throw new LiveEvalCallError(
        response.id,
        usage,
        response.model,
        'INVALID_BASELINE_JSON',
      );
    }
    return {
      providerRequestId: response.id,
      requestedModel: ANALYSIS_MODEL_VERSION,
      responseModel: response.model,
      promptVersion: ANALYSIS_PROMPT_MANIFESTS.baseline.promptVersion,
      schemaVersion: null,
      generatedAt: new Date().toISOString(),
      usage,
      output,
    };
  }
}

class LiveEvalCallError extends Error {
  constructor(
    readonly providerRequestId: string | null,
    readonly usage: LlmTokenUsage | null,
    readonly responseModel: string | null,
    readonly reason: string,
  ) {
    super('A live evaluation call failed after receiving a provider response.');
    this.name = LiveEvalCallError.name;
  }
}

async function runVariant(
  variant: AnalysisPromptVariant,
  runner: LiveEvalVariantRunner,
): Promise<LiveEvalVariantReport> {
  const outputs: AnalysisEvalInput[] = [];
  const cases: LiveEvalCaseMetadata[] = [];
  for (const fixture of ANALYSIS_GOLDEN_FIXTURES) {
    const startedAt = Date.now();
    const generatedAt = new Date().toISOString();
    try {
      const response = await runner.run(
        variant,
        prepareGoldenFixtureInput(fixture.input),
      );
      outputs.push({ fixtureId: fixture.id, output: response.output });
      cases.push({
        fixtureId: fixture.id,
        variant,
        providerRequestId: response.providerRequestId,
        requestedModel: response.requestedModel,
        responseModel: response.responseModel,
        promptVersion: response.promptVersion,
        schemaVersion: response.schemaVersion,
        generatedAt: response.generatedAt,
        latencyMs: Date.now() - startedAt,
        usage: response.usage,
        errorType: null,
        evidenceIssues: [],
        output: response.output,
      });
    } catch (error) {
      const metadata = errorMetadata(error);
      if (metadata.evidenceIssues !== null) {
        outputs.push({
          fixtureId: fixture.id,
          evidenceIssues: metadata.evidenceIssues,
        });
      }
      cases.push({
        fixtureId: fixture.id,
        variant,
        providerRequestId: metadata.providerRequestId,
        requestedModel: ANALYSIS_MODEL_VERSION,
        responseModel: metadata.responseModel,
        promptVersion: ANALYSIS_PROMPT_MANIFESTS[variant].promptVersion,
        schemaVersion:
          variant === 'candidate' ? ANALYSIS_RESULT_SCHEMA_VERSION : null,
        generatedAt,
        latencyMs: Date.now() - startedAt,
        usage: metadata.usage,
        errorType: metadata.errorType,
        evidenceIssues: metadata.evidenceIssues ?? [],
        output: null,
      });
    }
  }
  if (cases.length !== ANALYSIS_LIVE_EVAL_CASES_PER_VARIANT) {
    throw new Error('Each live evaluation variant must execute 24 cases.');
  }
  const totalTokens = cases
    .map((item) => item.usage?.totalTokens)
    .filter((value): value is number => value !== undefined);
  return {
    variant,
    prompt: ANALYSIS_PROMPT_MANIFESTS[variant],
    summary: gradeAnalysisOutputs(
      outputs,
      ANALYSIS_GOLDEN_FIXTURES,
      variant === 'baseline' ? 'legacy' : 'structured',
    ),
    averageTotalTokens:
      totalTokens.length === cases.length
        ? totalTokens.reduce((sum, value) => sum + value, 0) /
          totalTokens.length
        : null,
    nearestRankP95LatencyMs: nearestRankP95(
      cases.map((item) => item.latencyMs),
    ),
    usageComplete: totalTokens.length === cases.length,
    cases,
  };
}

function compareVariants(
  baseline: LiveEvalVariantReport,
  candidate: LiveEvalVariantReport,
): LiveEvalComparison {
  const candidateAtLeastAsGoodCases = candidate.summary.cases.filter(
    (candidateCase, index) =>
      isCandidateAtLeastAsGood(baseline.summary.cases[index], candidateCase),
  ).length;
  const averageTotalTokenRatio = ratio(
    candidate.averageTotalTokens,
    baseline.averageTotalTokens,
  );
  const nearestRankP95LatencyRatio = ratio(
    candidate.nearestRankP95LatencyMs,
    baseline.nearestRankP95LatencyMs,
  );
  const criteria = {
    labelsApproved: ANALYSIS_GOLDEN_LABEL_REVIEW.status === 'approved',
    candidateSchemaPassRate:
      candidate.summary.schemaPassedCases ===
      ANALYSIS_LIVE_EVAL_CASES_PER_VARIANT,
    candidateFabricatedPrCitations:
      candidate.summary.fabricatedPrCitations === 0,
    candidateWrongUserAttributions:
      candidate.summary.wrongUserAttributions === 0,
    candidateUnsupportedClaims: candidate.summary.unsupportedClaims === 0,
    candidateEvidenceValidationFailures:
      candidate.summary.evidenceValidationFailures === 0,
    candidateEvidenceGateFailures: candidate.summary.evidenceGateFailures === 0,
    candidateScoreBandAgreement:
      candidate.summary.scoreBandMatchingLabels >= ANALYSIS_EVAL_MIN_AGREEMENT,
    candidateAtLeastAsGoodCases: candidateAtLeastAsGoodCases >= 20,
    averageTotalTokensWithinTwentyPercent:
      averageTotalTokenRatio !== null && averageTotalTokenRatio <= 1.2,
    nearestRankP95LatencyWithinTwentyPercent:
      nearestRankP95LatencyRatio !== null && nearestRankP95LatencyRatio <= 1.2,
  };
  return {
    candidateAtLeastAsGoodCases,
    requiredCandidateAtLeastAsGoodCases: 20,
    totalCases: ANALYSIS_LIVE_EVAL_CASES_PER_VARIANT,
    averageTotalTokenRatio,
    nearestRankP95LatencyRatio,
    criteria,
    passed: Object.values(criteria).every(Boolean),
  };
}

function isCandidateAtLeastAsGood(
  baseline: AnalysisEvalCaseResult,
  candidate: AnalysisEvalCaseResult,
): boolean {
  return (
    Number(candidate.schemaPassed) >= Number(baseline.schemaPassed) &&
    candidate.fabricatedCitationCount <= baseline.fabricatedCitationCount &&
    candidate.wrongUserAttributionCount <= baseline.wrongUserAttributionCount &&
    candidate.unsupportedClaimCount <= baseline.unsupportedClaimCount &&
    Number(candidate.evidencePassed) >= Number(baseline.evidencePassed) &&
    Number(candidate.evidenceGatePassed) >=
      Number(baseline.evidenceGatePassed) &&
    candidate.matchingLabels >= baseline.matchingLabels
  );
}

export function nearestRankP95(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('Cannot calculate p95 without latency samples.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function ratio(
  numerator: number | null,
  denominator: number | null,
): number | null {
  if (
    numerator === null ||
    denominator === null ||
    denominator <= 0 ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator)
  ) {
    return null;
  }
  return numerator / denominator;
}

function normalizeUsage(
  usage:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    | null
    | undefined,
): LlmTokenUsage | null {
  if (
    !usage ||
    !Number.isInteger(usage.prompt_tokens) ||
    !Number.isInteger(usage.completion_tokens) ||
    !Number.isInteger(usage.total_tokens) ||
    usage.prompt_tokens < 0 ||
    usage.completion_tokens < 0 ||
    usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens
  ) {
    return null;
  }
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function errorMetadata(error: unknown): {
  providerRequestId: string | null;
  usage: LlmTokenUsage | null;
  responseModel: string | null;
  evidenceIssues: readonly EvidenceValidationIssue[] | null;
  errorType: string;
} {
  if (error instanceof LiveEvalCallError) {
    return {
      providerRequestId: error.providerRequestId,
      usage: error.usage,
      responseModel: error.responseModel,
      evidenceIssues: null,
      errorType: error.reason,
    };
  }
  if (error instanceof LlmProviderReconciliationError) {
    return {
      providerRequestId: error.providerRequestId,
      usage: error.usage,
      responseModel: error.responseModel,
      evidenceIssues: error.evidenceIssues,
      errorType: error.reason,
    };
  }
  return {
    providerRequestId: null,
    usage: null,
    responseModel: null,
    evidenceIssues: null,
    errorType: error instanceof Error ? error.name : 'UnknownError',
  };
}

function metricRow(
  label: string,
  baseline: string | number,
  candidate: string | number,
): string {
  return `| ${label} | ${baseline} | ${candidate} |`;
}

function formatRatio(value: number | null): string {
  return value === null ? 'unavailable' : value.toFixed(4);
}
