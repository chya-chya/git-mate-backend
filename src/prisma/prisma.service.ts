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

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    const maskedString = connectionString
      ? connectionString
          .replace(/:([^:@/]+)@/g, ':******@')
          .replace(/api_key=[^&]+/g, 'api_key=******')
      : 'undefined';

    const isLocal =
      connectionString?.includes('localhost') ||
      connectionString?.includes('127.0.0.1') ||
      connectionString?.includes('db');

    const poolConfig: PoolConfig = {
      connectionString,
      max: Number(process.env.DB_POOL_SIZE) || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    if (isLocal) {
      poolConfig.ssl = false;
    } else {
      const caCertPath = path.resolve(process.cwd(), 'certs/supabase-ca.crt');
      let caCert: string | undefined;

      try {
        if (fs.existsSync(caCertPath)) {
          caCert = fs.readFileSync(caCertPath, 'utf8');
        } else {
          Logger.warn(
            `SSL CA file not found at ${caCertPath}. Falling back to unverified SSL (Insecure!).`,
            PrismaService.name,
          );
        }
      } catch (err) {
        Logger.error(
          `Failed to read SSL CA certificate: ${err instanceof Error ? err.message : String(err)}`,
          PrismaService.name,
        );
      }

      poolConfig.ssl = caCert
        ? {
            rejectUnauthorized: true,
            ca: caCert,
          }
        : {
            rejectUnauthorized: false,
          };
    }

    const pool = new Pool(poolConfig);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const adapter = new PrismaPg(pool as any);
    super({ adapter });

    this.logger.log('--- Prisma Connection Debug ---');
    this.logger.log(`DATABASE_URL: ${maskedString}`);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
