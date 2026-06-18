import { Controller, Headers, HttpCode, Post, RawBody } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GithubAppWebhookService } from './github-app-webhook.service';

@ApiTags('GitHub App')
@Controller('github-app')
export class GithubAppWebhookController {
  constructor(
    private readonly githubAppWebhookService: GithubAppWebhookService,
  ) {}

  @Post('webhooks')
  @HttpCode(202)
  @ApiOperation({ summary: 'Receive verified GitHub App webhooks' })
  @ApiResponse({ status: 202, description: 'Webhook accepted' })
  async webhook(
    @RawBody() rawBody: Buffer | undefined,
    @Headers('x-hub-signature-256') signature?: string,
    @Headers('x-github-event') event?: string,
  ): Promise<{ accepted: true }> {
    await this.githubAppWebhookService.handle(rawBody, signature, event);
    return { accepted: true };
  }
}
