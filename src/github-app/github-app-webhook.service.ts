import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GithubInstallationStatus, Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GithubAppConfig } from './github-app.config';
import {
  GithubInstallationPayload,
  GithubInstallationWebhookPayload,
} from './github-app.types';

@Injectable()
export class GithubAppWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: GithubAppConfig,
  ) {}

  async handle(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    event: string | undefined,
  ): Promise<void> {
    if (!rawBody || !signature || !event) {
      throw new BadRequestException('Missing GitHub webhook headers or body');
    }
    this.verifySignature(rawBody, signature);

    if (event === 'ping') {
      return;
    }
    if (
      event !== 'installation' &&
      event !== 'installation_repositories' &&
      event !== 'installation_target'
    ) {
      return;
    }

    const payload = this.parsePayload(rawBody);
    if (event === 'installation') {
      await this.handleInstallation(payload);
      return;
    }
    if (
      event === 'installation_repositories' ||
      event === 'installation_target'
    ) {
      await this.upsertInstallation(payload.installation);
    }
  }

  private verifySignature(rawBody: Buffer, signature: string): void {
    const expected = `sha256=${createHmac('sha256', this.config.webhookSecret)
      .update(rawBody)
      .digest('hex')}`;
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Invalid GitHub webhook signature');
    }
  }

  private parsePayload(rawBody: Buffer): GithubInstallationWebhookPayload {
    try {
      const parsed = JSON.parse(
        rawBody.toString('utf8'),
      ) as GithubInstallationWebhookPayload;
      if (!parsed.action || !parsed.installation?.id) {
        throw new Error('Invalid payload');
      }
      return parsed;
    } catch {
      throw new BadRequestException('Invalid GitHub webhook payload');
    }
  }

  private async handleInstallation(
    payload: GithubInstallationWebhookPayload,
  ): Promise<void> {
    if (payload.action === 'deleted') {
      await this.prisma.githubInstallation.updateMany({
        where: { githubInstallationId: String(payload.installation.id) },
        data: {
          status: GithubInstallationStatus.DELETED,
          deletedAt: new Date(),
          suspendedAt: null,
        },
      });
      return;
    }

    if (payload.action === 'suspend') {
      await this.prisma.githubInstallation.updateMany({
        where: { githubInstallationId: String(payload.installation.id) },
        data: {
          status: GithubInstallationStatus.SUSPENDED,
          suspendedAt:
            this.toDate(payload.installation.suspended_at) ?? new Date(),
        },
      });
      return;
    }

    await this.upsertInstallation(payload.installation);
  }

  private async upsertInstallation(
    installation: GithubInstallationPayload,
  ): Promise<void> {
    if (!installation.account) {
      throw new BadRequestException('GitHub installation account is missing');
    }

    const data: Prisma.GithubInstallationUncheckedCreateInput = {
      githubInstallationId: String(installation.id),
      accountId: String(installation.account.id),
      accountLogin: installation.account.login,
      accountType:
        installation.account.type === 'Organization' ? 'ORGANIZATION' : 'USER',
      repositorySelection: installation.repository_selection,
      status: installation.suspended_at ? 'SUSPENDED' : 'ACTIVE',
      suspendedAt: this.toDate(installation.suspended_at),
      deletedAt: null,
      githubCreatedAt: this.toDate(installation.created_at),
      githubUpdatedAt: this.toDate(installation.updated_at),
    };

    await this.prisma.githubInstallation.upsert({
      where: { githubInstallationId: String(installation.id) },
      update: data,
      create: data,
    });
  }

  private toDate(value: string | null): Date | null {
    return value ? new Date(value) : null;
  }
}
