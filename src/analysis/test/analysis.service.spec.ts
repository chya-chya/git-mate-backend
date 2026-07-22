import { PrismaService } from '../../prisma/prisma.service';
import { AnalysisService } from '../analysis.service';
import { LlmProviderService } from '../llm-provider.service';
import { MetricCalculatorService } from '../metric-calculator.service';
import { PreprocessorService } from '../preprocessor.service';
import { RefinerService } from '../refiner.service';
import { StatService } from '../stat.service';

describe('AnalysisService', () => {
  it('updates the report, stats, and token balance with one transaction client', async () => {
    const transaction = {
      analysisReport: { create: jest.fn().mockResolvedValue({}) },
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
        usage: { totalTokens: 15 },
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
    const service = new AnalysisService(
      prisma as unknown as PrismaService,
      refiner as unknown as RefinerService,
      preprocessor as unknown as PreprocessorService,
      llmProvider as unknown as LlmProviderService,
      calculator as unknown as MetricCalculatorService,
      statService as unknown as StatService,
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
  });
});
