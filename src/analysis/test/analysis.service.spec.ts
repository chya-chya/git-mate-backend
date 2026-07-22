import { PrismaService } from '../../prisma/prisma.service';
import { AnalysisService } from '../analysis.service';
import { LlmProviderService } from '../llm-provider.service';
import { MetricCalculatorService } from '../metric-calculator.service';
import { PreprocessorService } from '../preprocessor.service';
import { RefinerService } from '../refiner.service';
import { StatService } from '../stat.service';
import { AnalysisJobService } from '../../analysis-job/analysis-job.service';

describe('AnalysisService', () => {
  it('updates the report, stats, and token balance with one transaction client', async () => {
    const transaction = {
      analysisReport: { create: jest.fn().mockResolvedValue({ id: 31 }) },
      user: { update: jest.fn().mockResolvedValue({}) },
      userStat: {},
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ availableTokens: 100 }),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback(transaction),
      ),
    };
    const refinedData = { pullRequests: [{}] };
    const refiner = { refine: jest.fn().mockReturnValue(refinedData) };
    const preprocessor = { preprocess: jest.fn().mockReturnValue({}) };
    const llmResult = { communicationStyle: 'clear' };
    const llmProvider = {
      analyze: jest.fn().mockResolvedValue({
        result: llmResult,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    };
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
    const calculator = { calculate: jest.fn().mockReturnValue(metrics) };
    const statService = { updateStats: jest.fn().mockResolvedValue({}) };
    const analysisJobService = { transition: jest.fn().mockResolvedValue({}) };
    const service = new AnalysisService(
      prisma as unknown as PrismaService,
      refiner as unknown as RefinerService,
      preprocessor as unknown as PreprocessorService,
      llmProvider as unknown as LlmProviderService,
      calculator as unknown as MetricCalculatorService,
      statService as unknown as StatService,
      analysisJobService as unknown as AnalysisJobService,
    );

    await service.runAnalysis(7, 9, {} as never);

    expect(transaction.analysisReport.create).toHaveBeenCalled();
    expect(statService.updateStats).toHaveBeenCalledWith(
      7,
      metrics,
      transaction,
    );
    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { availableTokens: { decrement: 15 } },
    });
    expect(analysisJobService.transition).not.toHaveBeenCalled();
  });

  it('commits the report, stats, tokens, and success CAS with the same transaction client', async () => {
    const transaction = {
      analysisReport: { create: jest.fn().mockResolvedValue({ id: 31 }) },
      user: { update: jest.fn().mockResolvedValue({}) },
      userStat: {},
      analysisJob: {},
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ availableTokens: 100 }),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback(transaction),
      ),
    };
    const refiner = {
      refine: jest.fn().mockReturnValue({ pullRequests: [{}] }),
    };
    const preprocessor = { preprocess: jest.fn().mockReturnValue({}) };
    const llmResult = { communicationStyle: 'clear' };
    const llmProvider = {
      analyze: jest.fn().mockResolvedValue({
        result: llmResult,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    };
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
    const calculator = { calculate: jest.fn().mockReturnValue(metrics) };
    const statService = { updateStats: jest.fn().mockResolvedValue({}) };
    const analysisJobService = { transition: jest.fn().mockResolvedValue({}) };
    const service = new AnalysisService(
      prisma as unknown as PrismaService,
      refiner as unknown as RefinerService,
      preprocessor as unknown as PreprocessorService,
      llmProvider as unknown as LlmProviderService,
      calculator as unknown as MetricCalculatorService,
      statService as unknown as StatService,
      analysisJobService as unknown as AnalysisJobService,
    );

    await service.runAnalysisJob(7, 9, {} as never, {
      jobId: 'job-1',
      leaseToken: 'lease-1',
      providerRequestIds: ['req_123'],
    });

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
    expect(transaction.user.update).toHaveBeenCalled();
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          jobId: string;
          expectedLeaseToken: string;
          data: {
            reportId: number;
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
            providerRequestIds: string[];
          };
        },
        unknown,
      ]
    >;
    const [transitionInput, transitionDatabase] = transitionCalls[0];
    expect(transitionInput.jobId).toBe('job-1');
    expect(transitionInput.expectedLeaseToken).toBe('lease-1');
    expect(transitionInput.data).toEqual(
      expect.objectContaining({
        reportId: 31,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        providerRequestIds: ['req_123'],
      }),
    );
    expect(transitionDatabase).toBe(transaction);

    const reportCall =
      transaction.analysisReport.create.mock.invocationCallOrder[0];
    const statCall = statService.updateStats.mock.invocationCallOrder[0];
    const tokenCall = transaction.user.update.mock.invocationCallOrder[0];
    const casCall = analysisJobService.transition.mock.invocationCallOrder[0];
    expect(reportCall).toBeLessThan(statCall);
    expect(statCall).toBeLessThan(tokenCall);
    expect(tokenCall).toBeLessThan(casCall);

    analysisJobService.transition.mockRejectedValueOnce(
      new Error('stale lease'),
    );
    await expect(
      service.runAnalysisJob(7, 9, {} as never, {
        jobId: 'job-1',
        leaseToken: 'stale-lease',
        providerRequestIds: ['req_123'],
      }),
    ).rejects.toThrow('stale lease');
  });
});
