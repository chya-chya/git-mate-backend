import { AnalysisJobService } from '../../analysis-job/analysis-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AnalysisService,
  InsufficientAnalysisTokensError,
} from '../analysis.service';
import { LlmProviderService } from '../llm-provider.service';
import { MetricCalculatorService } from '../metric-calculator.service';
import { PreprocessorService } from '../preprocessor.service';
import { RefinerService } from '../refiner.service';
import { StatService } from '../stat.service';

describe('AnalysisService', () => {
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
  const llmResult = { communicationStyle: 'clear' };

  function createFixture(tokenSettlementCount = 1, availableTokens = 100) {
    const transaction = {
      analysisReport: { create: jest.fn().mockResolvedValue({ id: 31 }) },
      user: {
        updateMany: jest
          .fn()
          .mockResolvedValue({ count: tokenSettlementCount }),
      },
      userStat: {},
      analysisJob: {},
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ availableTokens }),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback(transaction),
      ),
    };
    const refiner = {
      refine: jest.fn().mockReturnValue({ pullRequests: [{}] }),
    };
    const preprocessor = { preprocess: jest.fn().mockReturnValue({}) };
    const llmProvider = {
      analyze: jest.fn().mockResolvedValue({
        result: llmResult,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    };
    const calculator = { calculate: jest.fn().mockReturnValue(metrics) };
    const statService = { updateStats: jest.fn().mockResolvedValue({}) };
    const analysisJobService = {
      getRunningJobContext: jest.fn().mockResolvedValue({
        id: 'job-1',
        userId: 7,
        repositoryId: 9,
      }),
      transition: jest.fn().mockResolvedValue({}),
    };
    const service = new AnalysisService(
      prisma as unknown as PrismaService,
      refiner as unknown as RefinerService,
      preprocessor as unknown as PreprocessorService,
      llmProvider as unknown as LlmProviderService,
      calculator as unknown as MetricCalculatorService,
      statService as unknown as StatService,
      analysisJobService as unknown as AnalysisJobService,
    );

    return {
      analysisJobService,
      prisma,
      service,
      statService,
      transaction,
    };
  }

  it('keeps the synchronous report, stats, and token update atomic', async () => {
    const { analysisJobService, service, statService, transaction } =
      createFixture();

    await service.runAnalysis(7, 9, {} as never);

    expect(transaction.analysisReport.create).toHaveBeenCalledWith({
      data: {
        userId: 7,
        repositoryId: 9,
        metrics: llmResult,
      },
    });
    expect(statService.updateStats).toHaveBeenCalledWith(
      7,
      metrics,
      transaction,
    );
    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 7, availableTokens: { gte: 15 } },
      data: { availableTokens: { decrement: 15 } },
    });
    expect(analysisJobService.getRunningJobContext).not.toHaveBeenCalled();
    expect(analysisJobService.transition).not.toHaveBeenCalled();
  });

  it('derives worker ownership from the ledger and uses it in the success CAS', async () => {
    const { analysisJobService, service, statService, transaction } =
      createFixture();

    await service.runAnalysisJob({} as never, {
      jobId: 'job-1',
      leaseToken: 'lease-1',
      providerRequestIds: ['req_123'],
    });

    expect(analysisJobService.getRunningJobContext).toHaveBeenCalledWith(
      'job-1',
      'lease-1',
    );
    expect(transaction.analysisReport.create).toHaveBeenCalledWith({
      data: {
        userId: 7,
        repositoryId: 9,
        metrics: llmResult,
        jobId: 'job-1',
      },
    });
    expect(statService.updateStats).toHaveBeenCalledWith(
      7,
      metrics,
      transaction,
    );

    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          expectedUserId: number;
          expectedRepositoryId: number;
          data: { reportId: number };
        },
        unknown,
      ]
    >;
    const [transitionInput, transitionDatabase] = transitionCalls[0];
    expect(transitionInput.expectedUserId).toBe(7);
    expect(transitionInput.expectedRepositoryId).toBe(9);
    expect(transitionInput.data.reportId).toBe(31);
    expect(transitionDatabase).toBe(transaction);

    const reportCall =
      transaction.analysisReport.create.mock.invocationCallOrder[0];
    const statCall = statService.updateStats.mock.invocationCallOrder[0];
    const tokenCall = transaction.user.updateMany.mock.invocationCallOrder[0];
    const casCall = analysisJobService.transition.mock.invocationCallOrder[0];
    expect(reportCall).toBeLessThan(statCall);
    expect(statCall).toBeLessThan(tokenCall);
    expect(tokenCall).toBeLessThan(casCall);
  });

  it('rolls back the worker result when the atomic token settlement does not match', async () => {
    const { analysisJobService, service, transaction } = createFixture(0, 10);

    await expect(
      service.runAnalysisJob({} as never, {
        jobId: 'job-1',
        leaseToken: 'lease-1',
        providerRequestIds: ['req_123'],
      }),
    ).rejects.toBeInstanceOf(InsufficientAnalysisTokensError);

    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 7, availableTokens: { gte: 15 } },
      data: { availableTokens: { decrement: 15 } },
    });
    expect(analysisJobService.transition).not.toHaveBeenCalled();
  });

  it('propagates a stale success CAS so the worker transaction rolls back', async () => {
    const { analysisJobService, service } = createFixture();
    analysisJobService.transition.mockRejectedValueOnce(
      new Error('stale lease'),
    );

    await expect(
      service.runAnalysisJob({} as never, {
        jobId: 'job-1',
        leaseToken: 'stale-lease',
        providerRequestIds: ['req_123'],
      }),
    ).rejects.toThrow('stale lease');
  });
});
