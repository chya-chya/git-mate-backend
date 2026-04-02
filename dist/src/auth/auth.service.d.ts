import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from './encryption.service';
interface User {
    id: number;
    username: string;
    githubId: string;
    avatarUrl?: string | null;
    githubToken?: string | null;
}
export declare class AuthService {
    private prisma;
    private encryptionService;
    private jwtService;
    constructor(prisma: PrismaService, encryptionService: EncryptionService, jwtService: JwtService);
    login(user: User): Promise<{
        access_token: string;
        refresh_token: string;
    }>;
    getTokens(userId: number, username: string): Promise<{
        access_token: string;
        refresh_token: string;
    }>;
    updateRefreshToken(userId: number, refreshToken: string): Promise<void>;
    refreshTokens(userId: number, refreshToken: string): Promise<{
        access_token: string;
        refresh_token: string;
    }>;
    validateUser(details: {
        githubId: string;
        username: string;
        avatarUrl: string;
        accessToken: string;
    }): Promise<any>;
}
export {};
