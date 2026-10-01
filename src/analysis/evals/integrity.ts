import { createHash } from 'node:crypto';
import { ANALYSIS_GOLDEN_FIXTURES } from './golden-fixtures';
import { ANALYSIS_PROMPT_MANIFESTS } from './prompt-variants';
import {
  CHECKED_IN_REFERENCE_OUTPUTS,
  REFERENCE_OUTPUT_PROVENANCE,
} from './reference-outputs';

export const EXPECTED_FIXTURE_CHECKSUM =
  '3bbd04f764a8cf72ecec41189ae64479d5682b4d09afcfdbd0d47e2e8466ef6a';
export const EXPECTED_REFERENCE_OUTPUT_CHECKSUM =
  '3a193e27d045eef031d17a92555fe39ecd145e173bbcc31dfd4ea7eb5ea6def2';
export const EXPECTED_PROMPT_MANIFEST_CHECKSUM =
  '9048b0cc56662abe9d6610c8cdc655f4081124d52e4235c638a171f6df9c2ffe';

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
