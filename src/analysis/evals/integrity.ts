import { createHash } from 'node:crypto';
import { ANALYSIS_GOLDEN_FIXTURES } from './golden-fixtures';
import { ANALYSIS_PROMPT_MANIFESTS } from './prompt-variants';
import {
  CHECKED_IN_REFERENCE_OUTPUTS,
  REFERENCE_OUTPUT_PROVENANCE,
} from './reference-outputs';

export const EXPECTED_FIXTURE_CHECKSUM =
  '7ab98a9ebadf411c56c8a8977d4080ed968552c98e2fca9d79fdf03e11465af0';
export const EXPECTED_REFERENCE_OUTPUT_CHECKSUM =
  '434d4b4ef829139c8c674093f27f8a4e54cd8fc788968a8262f43bab13398112';
export const EXPECTED_PROMPT_MANIFEST_CHECKSUM =
  '7fb77a9633cd4371eb11df4ccfc7a777f3cad4ab859b93a002fe38056966151e';

export interface AnalysisEvalIntegrity {
  fixtures: IntegrityItem;
  referenceOutputs: IntegrityItem;
  promptManifests: IntegrityItem;
  passed: boolean;
}

interface IntegrityItem {
  expectedSha256: string;
  actualSha256: string;
  matches: boolean;
}

export function getAnalysisEvalIntegrity(): AnalysisEvalIntegrity {
  const fixtureChecksum = checksum(ANALYSIS_GOLDEN_FIXTURES);
  const referenceChecksum = checksum({
    provenance: REFERENCE_OUTPUT_PROVENANCE,
    outputs: CHECKED_IN_REFERENCE_OUTPUTS,
  });
  const promptManifestChecksum = checksum(ANALYSIS_PROMPT_MANIFESTS);
  const fixtures = integrityItem(EXPECTED_FIXTURE_CHECKSUM, fixtureChecksum);
  const referenceOutputs = integrityItem(
    EXPECTED_REFERENCE_OUTPUT_CHECKSUM,
    referenceChecksum,
  );
  const promptManifests = integrityItem(
    EXPECTED_PROMPT_MANIFEST_CHECKSUM,
    promptManifestChecksum,
  );
  return {
    fixtures,
    referenceOutputs,
    promptManifests,
    passed:
      fixtures.matches && referenceOutputs.matches && promptManifests.matches,
  };
}

export function assertAnalysisEvalIntegrity(): AnalysisEvalIntegrity {
  const integrity = getAnalysisEvalIntegrity();
  if (!integrity.passed) {
    throw new Error(
      'Analysis evaluation fixtures, reference outputs, or prompts changed without an explicit checksum update.',
    );
  }
  return integrity;
}

function integrityItem(
  expectedSha256: string,
  actualSha256: string,
): IntegrityItem {
  return {
    expectedSha256,
    actualSha256,
    matches: expectedSha256 === actualSha256,
  };
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
