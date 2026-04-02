import { Injectable, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from './encryption.service';

interface User {
  id: number;
  username: string;
  githubId: string;
  avatarUrl?: string | null;
  githubToken?: string | null;
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
      this.jwtService.signAsync(
        { sub: userId, username },
        { expiresIn: '7d' },
      ),
    ]);

    return {
      access_token: at,
      refresh_token: rt,
    };
  }

  async updateRefreshToken(userId: number, refreshToken: string) {
    const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);
    await (this.prisma as any).user.update({
      where: { id: userId },
      data: { hashedRefreshToken },
    });
  }

  async refreshTokens(userId: number, refreshToken: string) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.hashedRefreshToken) {
      throw new ForbiddenException('Access Denied');
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

  async validateUser(details: {
    githubId: string;
    username: string;
    avatarUrl: string;
    accessToken: string;
  }) {
    const encryptedToken = this.encryptionService.encrypt(details.accessToken);

    const user = await (this.prisma as any).user.upsert({
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
}
