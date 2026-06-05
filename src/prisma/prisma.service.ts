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
      poolConfig.ssl = {
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
