import { ConfigService } from '@nestjs/config';
import {
  ANALYSIS_GOLDEN_FIXTURES,
  prepareGoldenFixtureInput,
} from './golden-fixtures';
import {
  AnalysisEvalInput,
  AnalysisEvalSummary,
  gradeAnalysisOutputs,
} from './grader';
import {
  ANALYSIS_MODEL_VERSION,
  ANALYSIS_PROMPT_VERSION,
} from '../analysis-execution-version';
import {
  LlmProviderReconciliationError,
  LlmProviderService,
  LlmTokenUsage,
} from '../llm-provider.service';
import { EvidenceValidationIssue } from '../evidence-validator';

export interface LiveEvalCaseMetadata {
  fixtureId: string;
  providerRequestId: string | null;
  requestedModel: string;
  responseModel: string | null;
  promptVersion: string;
  executedAt: string;
  latencyMs: number;
  usage: LlmTokenUsage | null;
  errorType: string | null;
  evidenceIssues: readonly EvidenceValidationIssue[];
}

export interface LiveEvalReport {
  kind: 'live-openai-analysis-eval';
  executedAt: string;
  requestedModel: string;
  promptVersion: string;
  callsAttempted: number;
  baseline: 'unavailable';
  summary: AnalysisEvalSummary;
  cases: readonly LiveEvalCaseMetadata[];
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
): Promise<LiveEvalReport> {
  assertLiveEvalOptIn(environment, false);
  const provider = new LlmProviderService(new ConfigService(environment));
  const outputs: AnalysisEvalInput[] = [];
  const cases: LiveEvalCaseMetadata[] = [];

  for (const fixture of ANALYSIS_GOLDEN_FIXTURES) {
    const startedAt = Date.now();
    const executedAt = new Date().toISOString();
    try {
      const response = await provider.analyze(
        prepareGoldenFixtureInput(fixture.input),
      );
      outputs.push({ fixtureId: fixture.id, output: response.result });
      cases.push({
        fixtureId: fixture.id,
        providerRequestId: response.providerRequestId,
        requestedModel: response.requestedModel,
        responseModel: response.responseModel,
        promptVersion: response.promptVersion,
        executedAt,
        latencyMs: Date.now() - startedAt,
        usage: response.usage,
        errorType: null,
        evidenceIssues: [],
      });
    } catch (error) {
      const evidenceIssues =
        error instanceof LlmProviderReconciliationError
          ? error.evidenceIssues
          : null;
      if (evidenceIssues !== null) {
        outputs.push({ fixtureId: fixture.id, evidenceIssues });
      }
      cases.push({
        fixtureId: fixture.id,
        providerRequestId:
          error instanceof LlmProviderReconciliationError
            ? error.providerRequestId
            : null,
        requestedModel: ANALYSIS_MODEL_VERSION,
        responseModel: null,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        executedAt,
        latencyMs: Date.now() - startedAt,
        usage:
          error instanceof LlmProviderReconciliationError ? error.usage : null,
        errorType:
          error instanceof LlmProviderReconciliationError
            ? error.reason
            : error instanceof Error
              ? error.name
              : 'UnknownError',
        evidenceIssues: evidenceIssues ?? [],
      });
    }
  }

  return {
    kind: 'live-openai-analysis-eval',
    executedAt: new Date().toISOString(),
    requestedModel: ANALYSIS_MODEL_VERSION,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    callsAttempted: ANALYSIS_GOLDEN_FIXTURES.length,
    baseline: 'unavailable',
    summary: gradeAnalysisOutputs(outputs),
    cases,
  };
}
