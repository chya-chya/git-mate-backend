import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  ANALYSIS_GOLDEN_FIXTURES,
  ANALYSIS_GOLDEN_LABEL_REVIEW,
} from '../evals/golden-fixtures';
import { getAnalysisEvalIntegrity } from '../evals/integrity';
import {
  ANALYSIS_LIVE_EVAL_MAX_CALLS,
  ANALYSIS_PROMPT_MANIFESTS,
  buildVariantMessages,
} from '../evals/prompt-variants';
import { REFERENCE_OUTPUT_PROVENANCE } from '../evals/reference-outputs';
import { LlmProviderService } from '../llm-provider.service';

describe('analysis evaluation infrastructure', () => {
  it('locks fixture, reference output, and prompt changes behind checksums', () => {
    expect(getAnalysisEvalIntegrity()).toMatchObject({
      fixtures: { matches: true },
      referenceOutputs: { matches: true },
      promptManifests: { matches: true },
      passed: true,
    });
  });

  it('records pending human approval without claiming model provenance', () => {
    expect(ANALYSIS_GOLDEN_LABEL_REVIEW).toEqual({
      version: 'analysis-golden-labels-draft-v1',
      status: 'pending-user-approval',
      approvedBy: null,
      approvedAt: null,
    });
    expect(REFERENCE_OUTPUT_PROVENANCE).toMatchObject({
      kind: 'human-authored-evaluation-reference',
      modelExecuted: false,
    });
  });

  it('records allowed actors and balanced adversarial risks for every fixture', () => {
    for (const fixture of ANALYSIS_GOLDEN_FIXTURES) {
      expect(fixture.labelReview).toBe(ANALYSIS_GOLDEN_LABEL_REVIEW);
      expect(fixture.validationRisk.length).toBeGreaterThan(0);
      expect(fixture.forbiddenEvidence.length).toBeGreaterThan(0);
      expect(fixture.allowedEvidence.every((item) => item.prNumber > 0)).toBe(
        true,
      );
    }
    expect(
      ANALYSIS_GOLDEN_FIXTURES.some((fixture) =>
        fixture.tags.includes('similar-usernames'),
      ),
    ).toBe(true);
    const sparse = ANALYSIS_GOLDEN_FIXTURES.find((fixture) =>
      fixture.tags.includes('sparse-evidence'),
    );
    expect(sparse).toMatchObject({ level: 'medium', evidenceRequired: [] });
  });

  it('uses the production candidate messages and immutable prompt manifests', () => {
    const fixture = ANALYSIS_GOLDEN_FIXTURES[0];
    const provider = new LlmProviderService(
      new ConfigService({ OPENAI_API_KEY: undefined }),
    );

    expect(buildVariantMessages('candidate', fixture.input)).toEqual(
      provider.buildAnalysisMessages(fixture.input),
    );
    expect(ANALYSIS_PROMPT_MANIFESTS).toMatchObject({
      baseline: {
        model: 'gpt-5-mini',
        promptVersion: 'analysis-v1',
        responseFormat: 'json_object',
        sourceRevision: 'e4368db13ffe283333a8e814da19d2888a31bc4a',
      },
      candidate: {
        model: 'gpt-5-mini',
        promptVersion: 'analysis-v2-structured-evidence',
        responseFormat: 'structured_output',
        sourceRevision: 'CURRENT_CHECKOUT',
      },
    });
    expect(ANALYSIS_PROMPT_MANIFESTS.baseline.checksumSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(ANALYSIS_PROMPT_MANIFESTS.candidate.checksumSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(ANALYSIS_LIVE_EVAL_MAX_CALLS).toBe(48);
  });

  it('covers evaluation scripts, fixtures, docs, and workflows in PR CI', () => {
    const ledger = readRepositoryFile('.github/workflows/analysis-ledger.yml');
    for (const requiredPath of [
      "'.github/workflows/analysis-evals.yml'",
      "'src/analysis/**'",
      "'scripts/analysis-eval-ci.ts'",
      "'scripts/analysis-eval-live.ts'",
      "'docs/ANALYSIS_EVALUATIONS.md'",
    ]) {
      expect(ledger).toContain(requiredPath);
    }
  });

  it('keeps paid evaluation manual/nightly only and uploads both reports', () => {
    const workflow = readRepositoryFile('.github/workflows/analysis-evals.yml');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('schedule:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toMatch(/^\s+push:/mu);
    expect(workflow).toContain("RUN_LIVE_OPENAI_EVALS: 'true'");
    expect(workflow).toContain('secrets.OPENAI_API_KEY');
    expect(workflow).toContain('timeout-minutes: 45');
    expect(workflow).toContain('.artifacts/analysis-evals/latest.json');
    expect(workflow).toContain('.artifacts/analysis-evals/latest.md');
  });
});

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}
