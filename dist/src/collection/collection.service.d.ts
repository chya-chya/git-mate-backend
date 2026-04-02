import { PrismaService } from '../prisma/prisma.service';
import { GithubProvider } from './github.provider';
import { ICollectionService } from './interfaces/collection.interface';
import { CollectedDataDto } from './types/github-api.types';
import { EncryptionService } from '../auth/encryption.service';
import { AnalysisService } from '../analysis/analysis.service';
export declare class CollectionService implements ICollectionService {
    private readonly prisma;
    private readonly githubProvider;
    private readonly encryptionService;
    private readonly analysisService;
    constructor(prisma: PrismaService, githubProvider: GithubProvider, encryptionService: EncryptionService, analysisService: AnalysisService);
    syncRepository(githubRepoId: string, userId: number): Promise<CollectedDataDto>;
    getRepositories(userId: number): Promise<any[]>;
}
