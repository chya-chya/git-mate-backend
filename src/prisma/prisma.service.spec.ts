import {
  createDatabaseSslConfig,
  getEffectiveDatabaseHost,
  removeDatabaseTlsQueryParameters,
} from './prisma.service';

describe('removeDatabaseTlsQueryParameters', () => {
  it('prevents connection string options from overriding verified TLS', () => {
    const connectionString = removeDatabaseTlsQueryParameters(
      'postgresql://user:password@db.example.com:5432/application?sslmode=no-verify&sslrootcert=other.crt&uselibpqcompat=true&application_name=git-mate',
    );
    const connectionUrl = new URL(connectionString);

    expect(connectionUrl.searchParams.has('sslmode')).toBe(false);
    expect(connectionUrl.searchParams.has('sslrootcert')).toBe(false);
    expect(connectionUrl.searchParams.has('uselibpqcompat')).toBe(false);
    expect(connectionUrl.searchParams.get('application_name')).toBe('git-mate');
  });
});

describe('createDatabaseSslConfig', () => {
  it('fails fast when the CA certificate is unavailable for a remote database', () => {
    expect(() =>
      createDatabaseSslConfig(
        'db.example.com',
        '/path/that/does/not/exist/supabase-ca.crt',
      ),
    ).toThrow('SSL CA certificate is required for remote database connections');
  });

  it('uses certificate verification for a remote database', () => {
    const ssl = createDatabaseSslConfig('db.example.com');

    if (!ssl || typeof ssl === 'boolean') {
      throw new Error('Expected a verified TLS configuration');
    }

    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain('BEGIN CERTIFICATE');
  });

  it('uses pg-compatible last-host precedence when deciding whether TLS is required', () => {
    const databaseHost = getEffectiveDatabaseHost(
      'postgresql://user:password@localhost:5432/application?host=db&host=remote.example.com',
    );
    const ssl = createDatabaseSslConfig(databaseHost);

    if (!ssl || typeof ssl === 'boolean') {
      throw new Error('Expected a verified TLS configuration');
    }

    expect(databaseHost).toBe('remote.example.com');
    expect(ssl.rejectUnauthorized).toBe(true);
  });
});
