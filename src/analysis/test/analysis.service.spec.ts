import { AnalysisJobService } from '../../analysis-job/analysis-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalysisService } from '../analysis.service';
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

  function createFixture(options?: {
    availableTokens?: number;
    pullRequests?: unknown[];
    reservedTokens?: number | null;
    tokenUpdateCount?: number;
  }) {
    const transaction = {
      analysisReport: { create: jest.fn().mockResolvedValue({ id: 31 }) },
      user: {
        updateMany: jest
          .fn()
          .mockResolvedValue({ count: options?.tokenUpdateCount ?? 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      userStat: {},
      analysisJob: {},
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          availableTokens: options?.availableTokens ?? 100,
        }),
      },
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback(transaction),
      ),
    };
    const refiner = {
      refine: jest.fn().mockReturnValue({
        pullRequests: options?.pullRequests ?? [{}],
      }),
    };
    const preprocessor = { preprocess: jest.fn().mockReturnValue({}) };
    const llmProvider = {
      estimateTokenReservationForData: jest.fn().mockReturnValue({
        estimatedTokens: 10,
        reservedTokens: 20,
      }),
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
        reservedTokens: options?.reservedTokens ?? null,
      }),
      reserveTokens: jest.fn().mockResolvedValue({}),
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
      llmProvider,
      service,
      statService,
      transaction,
    };
  }

  const jobContext = {
    jobId: 'job-1',
    leaseToken: 'lease-1',
    providerRequestIds: ['req_123'],
  };

  it('keeps the synchronous report, stats, and token update atomic', async () => {
    const {
      analysisJobService,
      llmProvider,
      service,
      statService,
      transaction,
    } = createFixture();

    await service.runAnalysis(7, 9, {} as never);

    expect(transaction.analysisReport.create).toHaveBeenCalled();
    expect(statService.updateStats).toHaveBeenCalledWith(
      7,
      metrics,
      transaction,
    );
    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 7, availableTokens: { gte: 15 } },
      data: { availableTokens: { decrement: 15 } },
    });
    expect(llmProvider.estimateTokenReservationForData).not.toHaveBeenCalled();
    expect(analysisJobService.transition).not.toHaveBeenCalled();
  });

  it('reserves the worker budget before the LLM call and refunds the unused amount', async () => {
    const {
      analysisJobService,
      llmProvider,
      service,
      statService,
      transaction,
    } = createFixture();

    await service.runAnalysisJob({} as never, jobContext);

    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 7, availableTokens: { gte: 20 } },
      data: { availableTokens: { decrement: 20 } },
    });
    expect(analysisJobService.reserveTokens).toHaveBeenCalledWith(
      {
        jobId: 'job-1',
        expectedLeaseToken: 'lease-1',
        expectedUserId: 7,
        expectedRepositoryId: 9,
        estimatedTokens: 10,
        reservedTokens: 20,
      },
      transaction,
    );
    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { availableTokens: { increment: 5 } },
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
          toStatus: string;
          expectedReservedTokens: number;
          data: { reportId: number };
        },
        unknown,
      ]
    >;
    expect(transitionCalls[0][0].toStatus).toBe('SUCCEEDED');
    expect(transitionCalls[0][0].expectedReservedTokens).toBe(20);
    expect(transitionCalls[0][0].data.reportId).toBe(31);
    expect(transitionCalls[0][1]).toBe(transaction);

    const debitCall = transaction.user.updateMany.mock.invocationCallOrder[0];
    const reservationCall =
      analysisJobService.reserveTokens.mock.invocationCallOrder[0];
    const llmCall = llmProvider.analyze.mock.invocationCallOrder[0];
    const reportCall =
      transaction.analysisReport.create.mock.invocationCallOrder[0];
    const refundCall = transaction.user.update.mock.invocationCallOrder[0];
    const casCall = analysisJobService.transition.mock.invocationCallOrder[0];
    expect(debitCall).toBeLessThan(reservationCall);
    expect(reservationCall).toBeLessThan(llmCall);
    expect(llmCall).toBeLessThan(reportCall);
    expect(reportCall).toBeLessThan(refundCall);
    expect(refundCall).toBeLessThan(casCall);
  });

  it('does not reserve or debit a second time when the Job already has a reservation', async () => {
    const { analysisJobService, llmProvider, service, transaction } =
      createFixture({ reservedTokens: 20 });

    await service.runAnalysisJob({} as never, jobContext);

    expect(transaction.user.updateMany).not.toHaveBeenCalled();
    expect(analysisJobService.reserveTokens).not.toHaveBeenCalled();
    expect(llmProvider.analyze).toHaveBeenCalled();
    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { availableTokens: { increment: 5 } },
    });
  });

  it('does not call the LLM and terminates the Job when reservation fails', async () => {
    const { analysisJobService, llmProvider, service, transaction } =
      createFixture({ availableTokens: 0, tokenUpdateCount: 0 });

    await service.runAnalysisJob({} as never, jobContext);

    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 7, availableTokens: { gte: 20 } },
      data: { availableTokens: { decrement: 20 } },
    });
    expect(llmProvider.analyze).not.toHaveBeenCalled();
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          toStatus: string;
          expectedReservedTokens: null;
          data: { errorCode: string };
        },
        unknown,
      ]
    >;
    const failureInput = transitionCalls[0][0];
    expect(failureInput.toStatus).toBe('FAILED');
    expect(failureInput.expectedReservedTokens).toBeNull();
    expect(failureInput.data.errorCode).toBe('INSUFFICIENT_TOKENS');
  });

  it('terminates an empty worker analysis without reserving or calling the LLM', async () => {
    const { analysisJobService, llmProvider, service, transaction } =
      createFixture({ pullRequests: [] });

    await service.runAnalysisJob({} as never, jobContext);

    expect(transaction.user.updateMany).not.toHaveBeenCalled();
    expect(analysisJobService.reserveTokens).not.toHaveBeenCalled();
    expect(llmProvider.analyze).not.toHaveBeenCalled();
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          toStatus: string;
          data: { errorCode: string; totalTokens: number };
        },
        unknown,
      ]
    >;
    const failureInput = transitionCalls[0][0];
    expect(failureInput.toStatus).toBe('FAILED');
    expect(failureInput.data.errorCode).toBe('NO_ANALYZABLE_DATA');
    expect(failureInput.data.totalTokens).toBe(0);
  });

  it('propagates a stale success CAS so the worker transaction rolls back', async () => {
    const { analysisJobService, service } = createFixture();
    analysisJobService.transition.mockRejectedValueOnce(
      new Error('stale lease'),
    );

    await expect(
      service.runAnalysisJob({} as never, {
        ...jobContext,
        leaseToken: 'stale-lease',
      }),
    ).rejects.toThrow('stale lease');
  });
});
