import { Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { createSign } from 'node:crypto';
import { GithubAppConfig } from './github-app.config';

@Injectable()
export class GithubAppAuthService {
  constructor(private readonly config: GithubAppConfig) {}

  createAppOctokit(): Octokit {
    return new Octokit({ auth: this.createAppJwt() });
  }

  createUserOctokit(token: string): Octokit {
    return new Octokit({ auth: token });
  }

  private createAppJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = this.encode({ alg: 'RS256', typ: 'JWT' });
    const payload = this.encode({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: this.config.appId,
    });
    const unsignedToken = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsignedToken);
    signer.end();
    const signature = signer.sign(this.config.privateKey, 'base64url');

    return `${unsignedToken}.${signature}`;
  }

  private encode(value: Record<string, string | number>): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }
}
