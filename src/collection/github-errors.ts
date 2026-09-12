const MAX_RATE_LIMIT_DELAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 60 * 1000;

export class GithubPaginationError extends Error {
  constructor(connection: string, reason: string) {
    super(`GitHub ${connection} pagination is invalid: ${reason}.`);
    this.name = GithubPaginationError.name;
  }
}

export class InvalidGithubDateError extends Error {
  constructor(field: string) {
    super(`GitHub returned an invalid ${field} date.`);
    this.name = InvalidGithubDateError.name;
  }
}

export class GithubRateLimitError extends Error {
  readonly retryable = true;

  constructor(
    readonly status: number,
    readonly retryAt: Date,
    options?: ErrorOptions,
  ) {
    super('GitHub rate limit was exceeded.', options);
    this.name = GithubRateLimitError.name;
  }
}

export function normalizeGithubRequestError(
  error: unknown,
  now = new Date(),
): unknown {
  const status = numericProperty(error, 'status');
  if (status !== 403 && status !== 429) {
    return error;
  }

  const headers = responseHeaders(error);
  const retryAfter = validRetryAfter(headers.get('retry-after'), now);
  const remaining = headers.get('x-ratelimit-remaining')?.trim();
  const reset = validRateLimitReset(headers.get('x-ratelimit-reset'), now);
  const metadataIndicatesRateLimit = hasRateLimitMetadata(error);
  const isRateLimit =
    status === 429 ||
    retryAfter !== null ||
    remaining === '0' ||
    metadataIndicatesRateLimit;

  if (!isRateLimit) {
    return error;
  }

  const retryAt =
    retryAfter ??
    (remaining === '0' ? reset : null) ??
    new Date(now.getTime() + DEFAULT_RATE_LIMIT_DELAY_MS);
  return new GithubRateLimitError(status, retryAt, {
    cause: error instanceof Error ? error : undefined,
  });
}

function validRetryAfter(value: string | undefined, now: Date): Date | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const seconds = Number(value);
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds * 1000 > MAX_RATE_LIMIT_DELAY_MS
  ) {
    return null;
  }
  return new Date(now.getTime() + Math.ceil(seconds * 1000));
}

function validRateLimitReset(
  value: string | undefined,
  now: Date,
): Date | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const epochSeconds = Number(value);
  if (!Number.isFinite(epochSeconds) || epochSeconds < 0) {
    return null;
  }
  const reset = new Date(epochSeconds * 1000);
  const delay = reset.getTime() - now.getTime();
  return delay > 0 && delay <= MAX_RATE_LIMIT_DELAY_MS ? reset : null;
}

function responseHeaders(error: unknown): Map<string, string> {
  const normalized = new Map<string, string>();
  const response = objectProperty(error, 'response');
  const rawHeaders = objectProperty(response, 'headers');
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((value, key) =>
      normalized.set(key.toLowerCase(), value),
    );
    return normalized;
  }
  if (rawHeaders !== null) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === 'string' || typeof value === 'number') {
        normalized.set(key.toLowerCase(), String(value));
      }
    }
  }
  return normalized;
}

function hasRateLimitMetadata(error: unknown): boolean {
  const response = objectProperty(error, 'response');
  const data = objectProperty(response, 'data');
  const documentationUrl = stringProperty(data, 'documentation_url');
  if (documentationUrl?.toLowerCase().includes('rate-limit')) {
    return true;
  }
  const errors = arrayProperty(data, 'errors');
  const topLevelErrors = arrayProperty(error, 'errors');
  return [...errors, ...topLevelErrors].some((item) => {
    const type = stringProperty(item, 'type');
    return type?.toUpperCase() === 'RATE_LIMITED';
  });
}

function objectProperty(value: unknown, property: string): object | null {
  if (typeof value !== 'object' || value === null || !(property in value)) {
    return null;
  }
  const nested: unknown = value[property];
  return typeof nested === 'object' && nested !== null ? nested : null;
}

function arrayProperty(value: unknown, property: string): unknown[] {
  if (typeof value !== 'object' || value === null || !(property in value)) {
    return [];
  }
  const nested: unknown = value[property];
  return Array.isArray(nested) ? nested : [];
}

function stringProperty(value: unknown, property: string): string | null {
  if (typeof value !== 'object' || value === null || !(property in value)) {
    return null;
  }
  const nested: unknown = value[property];
  return typeof nested === 'string' ? nested : null;
}

function numericProperty(value: unknown, property: string): number | null {
  if (typeof value !== 'object' || value === null || !(property in value)) {
    return null;
  }
  const nested: unknown = value[property];
  return typeof nested === 'number' ? nested : null;
}
