import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GithubAppConfig } from './github-app.config';
import { GithubAppWebhookService } from './github-app-webhook.service';

describe('GithubAppWebhookService', () => {
  const prisma = {
    githubInstallation: {
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const config = {
    webhookSecret: 'webhook-secret',
  };

  let service: GithubAppWebhookService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GithubAppWebhookService(
      prisma as unknown as PrismaService,
      config as GithubAppConfig,
    );
  });

  it('marks an installation as deleted for a valid webhook', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        action: 'deleted',
        installation: {
          id: 123,
          account: {
            id: 10,
            login: 'git-mate-labs',
            type: 'Organization',
          },
          repository_selection: 'selected',
          suspended_at: null,
          created_at: '2026-06-11T00:00:00Z',
          updated_at: '2026-06-11T00:00:00Z',
        },
      }),
    );
    const signature = `sha256=${createHmac('sha256', config.webhookSecret)
      .update(rawBody)
      .digest('hex')}`;

    await service.handle(rawBody, signature, 'installation');

    expect(prisma.githubInstallation.updateMany).toHaveBeenCalledWith({
      where: { githubInstallationId: '123' },
      data: {
        status: 'DELETED',
        deletedAt: expect.any(Date) as Date,
        suspendedAt: null,
      },
    });
  });

  it('rejects an invalid webhook signature', async () => {
    const rawBody = Buffer.from('{}');

    await expect(
      service.handle(rawBody, 'sha256=invalid', 'installation'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.githubInstallation.updateMany).not.toHaveBeenCalled();
  });

  it('accepts a signed ping webhook without an installation payload', async () => {
    const rawBody = Buffer.from(JSON.stringify({ zen: 'Keep it simple.' }));
    const signature = `sha256=${createHmac('sha256', config.webhookSecret)
      .update(rawBody)
      .digest('hex')}`;

    await expect(
      service.handle(rawBody, signature, 'ping'),
    ).resolves.toBeUndefined();
    expect(prisma.githubInstallation.upsert).not.toHaveBeenCalled();
  });
});
