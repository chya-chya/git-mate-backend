import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

@Injectable()
export class GithubAppConfig {
  readonly appId: string;
  readonly installUrl: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly frontendUrl: string;
  readonly jwtSecret: string;

  constructor(configService: ConfigService) {
    this.appId = this.require(configService, 'GITHUB_APP_ID');
    this.installUrl = this.require(configService, 'GITHUB_APP_INSTALL_URL');
    this.webhookSecret = this.require(
      configService,
      'GITHUB_APP_WEBHOOK_SECRET',
    );
    this.jwtSecret = this.require(configService, 'JWT_SECRET');
    this.frontendUrl =
      configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3005';
    this.privateKey = this.loadPrivateKey(configService);
  }

  private loadPrivateKey(configService: ConfigService): string {
    const inlineKey = configService.get<string>('GITHUB_APP_PRIVATE_KEY');
    if (inlineKey) {
      return inlineKey.replace(/\\n/g, '\n');
    }

    const configuredPath = configService.get<string>(
      'GITHUB_APP_PRIVATE_KEY_PATH',
    );
    if (!configuredPath) {
      throw new Error(
        'GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is required',
      );
    }

    const privateKeyPath = path.resolve(process.cwd(), configuredPath);
    return fs.readFileSync(privateKeyPath, 'utf8');
  }

  private require(configService: ConfigService, key: string): string {
    const value = configService.get<string>(key);
    if (!value) {
      throw new Error(`${key} is required`);
    }
    return value;
  }
}
