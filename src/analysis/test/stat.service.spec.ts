import { PrismaService } from '../../prisma/prisma.service';
import { StatService } from '../stat.service';

describe('StatService', () => {
  const prisma = {
    userStat: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new StatService(prisma as unknown as PrismaService);
  const metrics = {
    mutualRespectScore: 4,
    conflictManagementScore: 4,
    logicalProblemScore: 4,
    reviewGuidingScore: 4,
    documentationScore: 4,
    knowledgeSharingScore: 4,
    technicalInfluenceScore: 4,
    codeStabilityScore: 4,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts analysisCount at one for the first analysis', async () => {
    prisma.userStat.findUnique.mockResolvedValue(null);
    prisma.userStat.create.mockResolvedValue({});

    await service.updateStats(7, metrics);

    expect(prisma.userStat.create).toHaveBeenCalledWith({
      data: {
        userId: 7,
        ...metrics,
        analysisCount: 1,
      },
    });
  });

  it('increments analysisCount for an existing aggregate', async () => {
    prisma.userStat.findUnique.mockResolvedValue({
      userId: 7,
      analysisCount: 3,
      ...metrics,
    });
    prisma.userStat.update.mockResolvedValue({});

    await service.updateStats(7, metrics);

    expect(prisma.userStat.update).toHaveBeenCalledWith({
      where: { userId: 7 },
      data: {
        ...metrics,
        analysisCount: { increment: 1 },
      },
    });
  });

  it('uses the supplied transaction client for the entire stat update', async () => {
    const transaction = {
      userStat: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn(),
      },
    };

    await service.updateStats(7, metrics, transaction as never);

    expect(transaction.userStat.findUnique).toHaveBeenCalled();
    expect(transaction.userStat.create).toHaveBeenCalled();
    expect(prisma.userStat.findUnique).not.toHaveBeenCalled();
    expect(prisma.userStat.create).not.toHaveBeenCalled();
  });
});
