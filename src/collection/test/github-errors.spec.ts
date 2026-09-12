import {
  GithubRateLimitError,
  normalizeGithubRequestError,
} from '../github-errors';

describe('normalizeGithubRequestError', () => {
  const now = new Date('2026-09-12T00:00:00.000Z');

  it('prioritizes a numeric Retry-After header case-insensitively', () => {
    const normalized = normalizeGithubRequestError(
      error(403, {
        'ReTrY-AfTeR': '120',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(now.getTime() / 1000 + 30),
      }),
      now,
    );

    expect(normalized).toMatchObject({
      name: GithubRateLimitError.name,
      retryAt: new Date('2026-09-12T00:02:00.000Z'),
    });
  });

  it('uses a future epoch reset when the primary budget is exhausted', () => {
    const normalized = normalizeGithubRequestError(
      error(403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(now.getTime() / 1000 + 45),
      }),
      now,
    );
    expect(normalized).toMatchObject({
      retryAt: new Date('2026-09-12T00:00:45.000Z'),
    });
  });

  it.each(['-1', 'NaN', '999999999'])(
    'falls back safely for invalid Retry-After %s',
    (retryAfter) => {
      const normalized = normalizeGithubRequestError(
        error(
          403,
          { 'retry-after': retryAfter },
          'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api',
        ),
        now,
      );
      expect(normalized).toMatchObject({
        retryAt: new Date('2026-09-12T00:01:00.000Z'),
      });
    },
  );

  it('falls back for a past reset and a secondary limit without headers', () => {
    const primary = normalizeGithubRequestError(
      error(403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(now.getTime() / 1000 - 1),
      }),
      now,
    );
    const secondary = normalizeGithubRequestError(
      error(
        403,
        {},
        'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api',
      ),
      now,
    );

    expect(primary).toMatchObject({
      retryAt: new Date('2026-09-12T00:01:00.000Z'),
    });
    expect(secondary).toMatchObject({
      retryAt: new Date('2026-09-12T00:01:00.000Z'),
    });
  });

  it('treats 429 as retryable but leaves an ordinary permission 403 unchanged', () => {
    const rateLimit = error(429, {});
    const permission = error(403, {});

    expect(normalizeGithubRequestError(rateLimit, now)).toBeInstanceOf(
      GithubRateLimitError,
    );
    expect(normalizeGithubRequestError(permission, now)).toBe(permission);
  });

  it.each([
    {
      name: 'Retry-After',
      headers: { 'retry-after': '90' },
      retryAt: new Date('2026-09-12T00:01:30.000Z'),
    },
    {
      name: 'rate-limit reset',
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(now.getTime() / 1000 + 45),
      },
      retryAt: new Date('2026-09-12T00:00:45.000Z'),
    },
    {
      name: 'default fallback',
      headers: {},
      retryAt: new Date('2026-09-12T00:01:00.000Z'),
    },
  ])(
    'normalizes a status-less GraphqlResponseError shape using $name',
    ({ headers, retryAt }) => {
      const errors = [{ type: 'RATE_LIMITED', message: 'API rate limit' }];
      const graphqlError = {
        name: 'GraphqlResponseError',
        request: {},
        headers,
        errors,
        data: null,
        response: { data: null, errors },
      };

      expect(normalizeGithubRequestError(graphqlError, now)).toMatchObject({
        name: GithubRateLimitError.name,
        status: 429,
        retryAt,
      });
    },
  );

  it('preserves an already normalized rate-limit error and its retry time', () => {
    const rateLimit = new GithubRateLimitError(
      429,
      new Date('2026-09-12T00:03:00.000Z'),
    );

    expect(normalizeGithubRequestError(rateLimit, now)).toBe(rateLimit);
  });

  function error(
    status: number,
    headers: Record<string, string>,
    documentationUrl?: string,
  ) {
    return {
      status,
      response: {
        headers,
        data: {
          ...(documentationUrl === undefined
            ? {}
            : { documentation_url: documentationUrl }),
        },
      },
    };
  }
});
