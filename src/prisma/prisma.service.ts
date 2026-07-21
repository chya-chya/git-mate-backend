import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, PoolConfig } from 'pg';
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

const DATABASE_TLS_QUERY_PARAMETERS = [
  'ssl',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'uselibpqcompat',
];

export function removeDatabaseTlsQueryParameters(
  connectionString: string,
): string {
  const connectionUrl = new URL(connectionString);

  for (const parameter of DATABASE_TLS_QUERY_PARAMETERS) {
    connectionUrl.searchParams.delete(parameter);
  }

  return connectionUrl.toString();
}

export function getEffectiveDatabaseHost(connectionString: string): string {
  const connectionUrl = new URL(connectionString);
  const queryHosts = connectionUrl.searchParams.getAll('host');
  const lastQueryHost = queryHosts.at(-1);

  return lastQueryHost || connectionUrl.hostname;
}

export function createDatabaseSslConfig(
  databaseHost: string,
  caCertPath = path.resolve(process.cwd(), 'certs/supabase-ca.crt'),
): PoolConfig['ssl'] {
  const isLocal = ['localhost', '127.0.0.1', 'db'].includes(databaseHost);

  if (isLocal) {
    return false;
  }

  let caCert: string;
  try {
    caCert = fs.readFileSync(caCertPath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SSL CA certificate is required for remote database connections. Failed to read ${caCertPath}: ${reason}`,
    );
  }

  return {
    rejectUnauthorized: true,
    ca: caCert,
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }

    const databaseHost = getEffectiveDatabaseHost(connectionString);

    const poolConfig: PoolConfig = {
      connectionString: removeDatabaseTlsQueryParameters(connectionString),
      max: Number(process.env.DB_POOL_SIZE) || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: createDatabaseSslConfig(databaseHost),
    };

    const pool = new Pool(poolConfig);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const adapter = new PrismaPg(pool as any);
    super({ adapter });

    this.logger.log('--- Prisma Connection Debug ---');
    this.logger.log(`Database host: ${databaseHost}`);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
