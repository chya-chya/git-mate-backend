import { createDatabaseSslConfig } from './prisma.service';

describe('createDatabaseSslConfig', () => {
  it('fails fast when the CA certificate is unavailable for a remote database', () => {
    expect(() =>
      createDatabaseSslConfig(
        'postgresql://user:password@db.example.com:5432/application',
        '/path/that/does/not/exist/supabase-ca.crt',
      ),
    ).toThrow('SSL CA certificate is required for remote database connections');
  });

  it('uses certificate verification for a remote database', () => {
    const ssl = createDatabaseSslConfig(
      'postgresql://user:password@db.example.com:5432/application',
    );

    if (!ssl || typeof ssl === 'boolean') {
      throw new Error('Expected a verified TLS configuration');
    }

    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain('BEGIN CERTIFICATE');
  });
});
