import { Test, TestingModule } from '@nestjs/testing';
import { CollectionService } from './collection.service';
import { GithubProvider } from './github.provider';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../auth/encryption.service';

describe('CollectionService', () => {
  let service: CollectionService;
  let mockGithubProvider: Partial<GithubProvider>;
  let mockPrismaService: any;
  let mockEncryptionService: Partial<EncryptionService>;

  beforeEach(async () => {
    mockGithubProvider = {
      fetchPullRequests: jest.fn(),
    };

    mockPrismaService = {
      repository: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    mockEncryptionService = {
      decrypt: jest.fn().mockReturnValue('decrypted-token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionService,
        { provide: GithubProvider, useValue: mockGithubProvider },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EncryptionService, useValue: mockEncryptionService },
      ],
    }).compile();

    service = module.get<CollectionService>(CollectionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('syncRepository', () => {
    it('should decrypt token and fetch data from GitHub', async () => {
      const mockRepo = {
        id: 1,
        githubRepoId: 'repo-123',
        fullName: 'owner/repo',
        lastSyncTime: new Date('2024-01-01'),
        ownerId: 1,
        owner: {
          username: 'user1',
          githubToken: 'encrypted-token',
        },
      };

      mockPrismaService.repository.findUnique.mockResolvedValue(mockRepo);
      (mockGithubProvider.fetchPullRequests as jest.Mock).mockResolvedValue({
        repository: {
          pullRequests: { nodes: [] },
        },
      });
      await service.syncRepository('repo-123', 1);

      expect(mockEncryptionService.decrypt).toHaveBeenCalledWith(
        'encrypted-token',
      );
      expect(mockGithubProvider.fetchPullRequests).toHaveBeenCalledWith(
        'owner',
        'repo',
        'decrypted-token',
        mockRepo.lastSyncTime,
      );
    });
  });
});
