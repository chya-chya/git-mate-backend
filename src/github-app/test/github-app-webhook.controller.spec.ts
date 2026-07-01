import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { GithubAppWebhookController } from '.././github-app-webhook.controller';
import { GithubAppWebhookService } from '.././github-app-webhook.service';

describe('GithubAppWebhookController raw body', () => {
  const webhookService = {
    handle: jest.fn(),
  };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GithubAppWebhookController],
      providers: [
        {
          provide: GithubAppWebhookService,
          useValue: webhookService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the exact request bytes to signature verification', async () => {
    const payload = '{"zen":"Keep it logically awesome."}';

    await request(app.getHttpServer() as App)
      .post('/github-app/webhooks')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', 'sha256=test-signature')
      .set('x-github-event', 'ping')
      .send(payload)
      .expect(202)
      .expect({ accepted: true });

    expect(webhookService.handle).toHaveBeenCalledTimes(1);
    expect(webhookService.handle).toHaveBeenCalledWith(
      Buffer.from(payload),
      'sha256=test-signature',
      'ping',
    );
  });
});
