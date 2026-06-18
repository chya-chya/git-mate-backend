import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-github2';
import { ConfigService } from '@nestjs/config';

export const GITHUB_OAUTH_SCOPES = ['read:user', 'read:org'];

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('GITHUB_CLIENT_ID')!,
      clientSecret: configService.get<string>('GITHUB_CLIENT_SECRET')!,
      callbackURL: configService.get<string>('GITHUB_CALLBACK_URL')!,
      scope: GITHUB_OAUTH_SCOPES,
    });
  }

  validate(accessToken: string, refreshToken: string, profile: Profile) {
    return {
      githubId: profile.id,
      username: profile.username,
      avatarUrl: profile.photos?.[0]?.value ?? '',
      accessToken,
    };
  }
}
