import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { GithubAppAuthService } from './github-app-auth.service';
import { GithubAppConfig } from './github-app.config';
import { GithubAppController } from './github-app.controller';
import { GithubAppService } from './github-app.service';
import { GithubAppWebhookController } from './github-app-webhook.controller';
import { GithubAppWebhookService } from './github-app-webhook.service';
import { GithubInstallationTokenService } from './github-installation-token.service';

@Module({
  imports: [AuthModule, PrismaModule, JwtModule.register({})],
  controllers: [GithubAppController, GithubAppWebhookController],
  providers: [
    GithubAppConfig,
    GithubAppAuthService,
    GithubAppService,
    GithubAppWebhookService,
    GithubInstallationTokenService,
  ],
  exports: [
    GithubAppAuthService,
    GithubAppService,
    GithubInstallationTokenService,
  ],
})
export class GithubAppModule {}
