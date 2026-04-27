import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service';

describe('EncryptionService', () => {
  let service: EncryptionService;
  let mockConfigService: Partial<ConfigService>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'ENCRYPTION_KEY') {
          // 32 bytes (64 hex chars)
          return '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        }
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EncryptionService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<EncryptionService>(EncryptionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should encrypt and decrypt correctly', () => {
    const originalText = 'github-token-123';
    const encrypted = service.encrypt(originalText);

    expect(encrypted).not.toBe(originalText);
    expect(encrypted).toContain(':'); // IV:AuthTag:Cipher

    const decrypted = service.decrypt(encrypted);
    expect(decrypted).toBe(originalText);
  });
});
