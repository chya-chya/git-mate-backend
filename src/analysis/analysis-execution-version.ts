export const ANALYSIS_MODEL_VERSION = 'gpt-5-mini';
export const ANALYSIS_PROMPT_VERSION = 'analysis-v1';

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

export function assertSupportedAnalysisExecutionVersion(
  version: AnalysisExecutionVersion,
): void {
  if (!isSupportedAnalysisExecutionVersion(version)) {
    throw new UnsupportedAnalysisExecutionVersionError(version);
  }
}
