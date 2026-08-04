export interface AnalysisTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;

export function isValidAnalysisTokenUsage(usage: AnalysisTokenUsage): boolean {
  return (
    Number.isSafeInteger(usage.promptTokens) &&
    usage.promptTokens >= 0 &&
    Number.isSafeInteger(usage.completionTokens) &&
    usage.completionTokens >= 0 &&
    Number.isSafeInteger(usage.totalTokens) &&
    usage.totalTokens >= 0 &&
    usage.promptTokens + usage.completionTokens === usage.totalTokens
  );
}

export function isValidProviderRequestId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_REQUEST_ID_PATTERN.test(value);
}
