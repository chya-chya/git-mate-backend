import {
  Injectable,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from './encryption.service';
import type { GithubOAuthStatePayload } from './guards/github-oauth.guard';

interface User {
  id: number;
  username: string;
  githubId: string;
  avatarUrl?: string | null;
  githubToken?: string | null;
  status?: UserStatus;
}

export interface GithubOAuthDetails {
  githubId: string;
  username: string;
  avatarUrl: string;
  accessToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private encryptionService: EncryptionService,
    private jwtService: JwtService,
  ) {}

  async login(user: User) {
    const tokens = await this.getTokens(user.id, user.username);
    await this.updateRefreshToken(user.id, tokens.refresh_token);
    return tokens;
  }

  async getTokens(userId: number, username: string) {
    const [at, rt] = await Promise.all([
      this.jwtService.signAsync(
        { sub: userId, username },
        { expiresIn: '15m' },
      ),
      this.jwtService.signAsync({ sub: userId, username }, { expiresIn: '7d' }),
    ]);

    return {
      access_token: at,
      refresh_token: rt,
    };
  }

  async updateRefreshToken(userId: number, refreshToken: string) {
    const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { hashedRefreshToken },
    });
  }

  async refreshTokens(userId: number, refreshToken: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.hashedRefreshToken) {
      throw new ForbiddenException('Access Denied');
    }

    if (user.status === UserStatus.DEACTIVATED) {
      throw new ForbiddenException({
        code: 'ACCOUNT_DEACTIVATED',
        message: 'Account is deactivated',
      });
    }

    const refreshTokenMatches = await bcrypt.compare(
      refreshToken,
      user.hashedRefreshToken,
    );

    if (!refreshTokenMatches) {
      throw new ForbiddenException('Access Denied');
    }

    const tokens = await this.getTokens(user.id, user.username);
    await this.updateRefreshToken(user.id, tokens.refresh_token);
    return tokens;
  }

  async completeGithubOAuth(details: GithubOAuthDetails, state?: unknown) {
    if (!state) {
      return this.validateUser(details);
    }

    if (typeof state !== 'string') {
      throw new UnauthorizedException('Invalid GitHub OAuth state');
    }

    const payload = await this.verifyGithubOAuthState(state);
    return this.reauthorizeGithubUser(payload.sub, details);
  }

  async validateUser(details: GithubOAuthDetails) {
    const existingUser = await this.prisma.user.findUnique({
      where: { githubId: details.githubId },
      select: { id: true, status: true },
    });

    if (existingUser?.status === UserStatus.DEACTIVATED) {
      throw new ForbiddenException({
        code: 'ACCOUNT_DEACTIVATED',
        message: 'Account is deactivated',
      });
    }

    const encryptedToken = this.encryptionService.encrypt(details.accessToken);

    const user = await this.prisma.user.upsert({
      where: { githubId: details.githubId },
      update: {
        username: details.username,
        avatarUrl: details.avatarUrl,
        githubToken: encryptedToken,
      },
      create: {
        githubId: details.githubId,
        username: details.username,
        avatarUrl: details.avatarUrl,
        githubToken: encryptedToken,
      },
    });

    return user;
  }

  async reauthorizeGithubUser(userId: number, details: GithubOAuthDetails) {
    const existingUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        githubId: true,
        status: true,
      },
    });

    if (!existingUser) {
      throw new UnauthorizedException('Invalid GitHub OAuth state');
    }

    if (existingUser.status === UserStatus.DEACTIVATED) {
      throw new ForbiddenException({
        code: 'ACCOUNT_DEACTIVATED',
        message: 'Account is deactivated',
      });
    }

    if (existingUser.githubId !== details.githubId) {
      throw new ForbiddenException(
        'GitHub account does not match the authenticated user',
      );
    }

    const encryptedToken = this.encryptionService.encrypt(details.accessToken);

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        username: details.username,
        avatarUrl: details.avatarUrl,
        githubToken: encryptedToken,
      },
    });
  }

  private async verifyGithubOAuthState(
    state: string,
  ): Promise<GithubOAuthStatePayload> {
    try {
      const payload =
        await this.jwtService.verifyAsync<GithubOAuthStatePayload>(state);

      if (payload.purpose !== 'github-oauth-reauthorize') {
        throw new UnauthorizedException('Invalid GitHub OAuth state');
      }

      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid GitHub OAuth state');
    }
  }
}
