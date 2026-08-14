import { StatService } from '../stat.service';

describe('StatService', () => {
  const transaction = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    userStat: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new StatService();
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
    transaction.userStat.findUnique.mockResolvedValue(null);
    transaction.userStat.create.mockResolvedValue({});

    await service.updateStats(7, metrics, transaction as never);

    expect(transaction.$executeRaw).toHaveBeenCalled();
    expect(transaction.userStat.create).toHaveBeenCalledWith({
      data: {
        userId: 7,
        ...metrics,
        analysisCount: 1,
      },
    });
    expect(transaction.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.userStat.findUnique.mock.invocationCallOrder[0],
    );
  });

  it('increments analysisCount for an existing aggregate', async () => {
    transaction.userStat.findUnique.mockResolvedValue({
      userId: 7,
      analysisCount: 3,
      ...metrics,
    });
    transaction.userStat.update.mockResolvedValue({});

    await service.updateStats(7, metrics, transaction as never);

    expect(transaction.userStat.update).toHaveBeenCalledWith({
      where: { userId: 7 },
      data: {
        ...metrics,
        analysisCount: { increment: 1 },
      },
    });
  });

  it('uses the supplied transaction client for the entire stat update', async () => {
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      userStat: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn(),
      },
    };

    await service.updateStats(7, metrics, transaction as never);

    expect(transaction.userStat.findUnique).toHaveBeenCalled();
    expect(transaction.userStat.create).toHaveBeenCalled();
    expect(transaction.$executeRaw).toHaveBeenCalled();
  });
});
