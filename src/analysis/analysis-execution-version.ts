export const ANALYSIS_MODEL_VERSION = 'gpt-5-mini';
export const ANALYSIS_PROMPT_VERSION =
  'analysis-v3-structured-evidence-rationale';
export const LEGACY_ANALYSIS_PROMPT_VERSION = 'analysis-v1';
export const PREVIOUS_ANALYSIS_PROMPT_VERSION =
  'analysis-v2-structured-evidence';

export interface AnalysisExecutionVersion {
  modelVersion: string;
  promptVersion: string;
}

export const CURRENT_ANALYSIS_EXECUTION_VERSION = Object.freeze({
  modelVersion: ANALYSIS_MODEL_VERSION,
  promptVersion: ANALYSIS_PROMPT_VERSION,
}) satisfies AnalysisExecutionVersion;

export class UnsupportedAnalysisExecutionVersionError extends Error {
  constructor(version: AnalysisExecutionVersion) {
    super(
      `Unsupported analysis execution version: ${version.modelVersion}/${version.promptVersion}`,
    );
    this.name = UnsupportedAnalysisExecutionVersionError.name;
  }
}

export function isSupportedAnalysisExecutionVersion(
  version: AnalysisExecutionVersion,
): boolean {
  return (
    version.modelVersion === ANALYSIS_MODEL_VERSION &&
    version.promptVersion === ANALYSIS_PROMPT_VERSION
  );
}

export function isRetiredAnalysisExecutionVersion(
  version: AnalysisExecutionVersion,
): boolean {
  return (
    version.modelVersion === ANALYSIS_MODEL_VERSION &&
    (version.promptVersion === LEGACY_ANALYSIS_PROMPT_VERSION ||
      version.promptVersion === PREVIOUS_ANALYSIS_PROMPT_VERSION)
  );
}

export function assertSupportedAnalysisExecutionVersion(
  version: AnalysisExecutionVersion,
): void {
  if (!isSupportedAnalysisExecutionVersion(version)) {
    throw new UnsupportedAnalysisExecutionVersionError(version);
  }
}
