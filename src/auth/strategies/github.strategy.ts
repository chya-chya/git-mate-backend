import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-github2';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('GITHUB_CLIENT_ID')!,
      clientSecret: configService.get<string>('GITHUB_CLIENT_SECRET')!,
      callbackURL: configService.get<string>('GITHUB_CALLBACK_URL')!,
      scope: ['user:email', 'repo', 'read:org'],
    });
  }

  async validate(accessToken: string, refreshToken: string, profile: Profile) {
    return {
      githubId: profile.id,
      username: profile.username,
      avatarUrl: (profile as any)._json?.avatar_url,
      accessToken,
    };
  }
}
