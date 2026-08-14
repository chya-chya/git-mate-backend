import { AnalysisJobService } from '../../analysis-job/analysis-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AnalysisJobExecutionOutcome,
  AnalysisJobRunnerService,
  InsufficientAnalysisTokensError,
  PostBillingAnalysisPersistenceError,
} from '../analysis.service';
import {
  LlmProviderReconciliationError,
  LlmProviderService,
} from '../llm-provider.service';
import { MetricCalculatorService } from '../metric-calculator.service';
import { PreprocessorService } from '../preprocessor.service';
import { RefinerService } from '../refiner.service';
import { StatService } from '../stat.service';
import {
  CURRENT_ANALYSIS_EXECUTION_VERSION,
  UnsupportedAnalysisExecutionVersionError,
} from '../analysis-execution-version';

describe('AnalysisJobRunnerService', () => {
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
    actualUsage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    analyzeError?: Error;
    executionVersion?: { modelVersion: string; promptVersion: string };
    providerCheckpoint?: {
      providerRequestId: string;
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
    };
    pullRequests?: unknown[];
    reportError?: Error;
    reservedTokens?: number | null;
    tokenUpdateCount?: number;
  }) {
    const reportCreate = options?.reportError
      ? jest.fn().mockRejectedValue(options.reportError)
      : jest.fn().mockResolvedValue({ id: 31 });
    const transaction = {
      analysisReport: { create: reportCreate },
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
    const analyze = options?.analyzeError
      ? jest.fn().mockRejectedValue(options.analyzeError)
      : jest.fn().mockResolvedValue({
          providerRequestId: 'chatcmpl_actual_123',
          result: llmResult,
          usage: options?.actualUsage ?? {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
        });
    const llmProvider = {
      estimateTokenReservationForData: jest.fn().mockReturnValue({
        estimatedTokens: 10,
        reservedTokens: 20,
      }),
      analyze,
    };
    const calculator = { calculate: jest.fn().mockReturnValue(metrics) };
    const statService = { updateStats: jest.fn().mockResolvedValue({}) };
    const analysisJobService = {
      create: jest.fn().mockResolvedValue({ id: 'job-1' }),
      getRunningJobContext: jest.fn().mockResolvedValue({
        id: 'job-1',
        userId: 7,
        repositoryId: 9,
        ...(options?.executionVersion ?? CURRENT_ANALYSIS_EXECUTION_VERSION),
        reservedTokens: options?.reservedTokens ?? null,
        promptTokens: options?.providerCheckpoint?.promptTokens ?? null,
        completionTokens: options?.providerCheckpoint?.completionTokens ?? null,
        totalTokens: options?.providerCheckpoint?.totalTokens ?? null,
        providerRequestIds:
          options?.providerCheckpoint === undefined
            ? []
            : [options.providerCheckpoint.providerRequestId],
      }),
      reserveTokens: jest.fn().mockResolvedValue({}),
      recordProviderCharge: jest.fn().mockResolvedValue({}),
      transition: jest.fn().mockResolvedValue({}),
    };
    const service = new AnalysisJobRunnerService(
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
  };

  it('backs the synchronous entry point with a durable analysis Job', async () => {
    const {
      analysisJobService,
      llmProvider,
      service,
      statService,
      transaction,
    } = createFixture();

    await service.runAnalysis(7, 9, {} as never);

    const createCalls = analysisJobService.create.mock
      .calls as unknown as Array<
      [{ userId: number; repositoryId: number; idempotencyKey: string }]
    >;
    expect(createCalls[0][0]).toMatchObject({ userId: 7, repositoryId: 9 });
    expect(createCalls[0][0].idempotencyKey).toMatch(/^sync:/);
    expect(transaction.analysisReport.create).toHaveBeenCalled();
    expect(statService.updateStats).toHaveBeenCalledWith(
      7,
      metrics,
      transaction,
    );
    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 7, availableTokens: { gte: 20 } },
      data: { availableTokens: { decrement: 20 } },
    });
    expect(llmProvider.estimateTokenReservationForData).toHaveBeenCalled();
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<[{ toStatus: string }]>;
    expect(transitionCalls.map(([input]) => input.toStatus)).toEqual([
      'RUNNING',
      'SUCCEEDED',
    ]);
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

    expect(llmProvider.estimateTokenReservationForData).toHaveBeenCalledWith(
      {},
      expect.objectContaining(CURRENT_ANALYSIS_EXECUTION_VERSION),
    );
    expect(llmProvider.analyze).toHaveBeenCalledWith(
      {},
      expect.objectContaining(CURRENT_ANALYSIS_EXECUTION_VERSION),
    );

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
    expect(analysisJobService.recordProviderCharge).toHaveBeenCalledWith({
      jobId: 'job-1',
      expectedLeaseToken: 'lease-1',
      expectedUserId: 7,
      expectedRepositoryId: 9,
      expectedReservedTokens: 20,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      providerRequestId: 'chatcmpl_actual_123',
    });
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
          data: { reportId: number; providerRequestIds: string[] };
        },
        unknown,
      ]
    >;
    expect(transitionCalls[0][0].toStatus).toBe('SUCCEEDED');
    expect(transitionCalls[0][0].expectedReservedTokens).toBe(20);
    expect(transitionCalls[0][0].data.reportId).toBe(31);
    expect(transitionCalls[0][0].data.providerRequestIds).toEqual([
      'chatcmpl_actual_123',
    ]);
    expect(transitionCalls[0][1]).toBe(transaction);

    const debitCall = transaction.user.updateMany.mock.invocationCallOrder[0];
    const reservationCall =
      analysisJobService.reserveTokens.mock.invocationCallOrder[0];
    const llmCall = llmProvider.analyze.mock.invocationCallOrder[0];
    const checkpointCall =
      analysisJobService.recordProviderCharge.mock.invocationCallOrder[0];
    const reportCall =
      transaction.analysisReport.create.mock.invocationCallOrder[0];
    const refundCall = transaction.user.update.mock.invocationCallOrder[0];
    const casCall = analysisJobService.transition.mock.invocationCallOrder[0];
    expect(debitCall).toBeLessThan(reservationCall);
    expect(reservationCall).toBeLessThan(llmCall);
    expect(llmCall).toBeLessThan(checkpointCall);
    expect(checkpointCall).toBeLessThan(reportCall);
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

  it('rejects an unsupported ledger version before reservation or provider calls', async () => {
    const { analysisJobService, llmProvider, service, transaction } =
      createFixture({
        executionVersion: {
          modelVersion: 'gpt-5.1',
          promptVersion: 'v2',
        },
      });

    await expect(
      service.runAnalysisJob({} as never, jobContext),
    ).rejects.toBeInstanceOf(UnsupportedAnalysisExecutionVersionError);

    expect(transaction.user.updateMany).not.toHaveBeenCalled();
    expect(analysisJobService.reserveTokens).not.toHaveBeenCalled();
    expect(llmProvider.analyze).not.toHaveBeenCalled();
  });

  it('does not call the LLM when a retry finds a durable provider checkpoint', async () => {
    const { analysisJobService, llmProvider, service, transaction } =
      createFixture({
        reservedTokens: 20,
        providerCheckpoint: {
          providerRequestId: 'chatcmpl_checkpoint_123',
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
      });

    await service.runAnalysisJob({} as never, jobContext);

    expect(llmProvider.analyze).not.toHaveBeenCalled();
    expect(analysisJobService.recordProviderCharge).not.toHaveBeenCalled();
    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { availableTokens: { increment: 5 } },
    });
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          toStatus: string;
          data: {
            errorCode: string;
            errorRetryable: boolean;
            providerRequestIds: string[];
            totalTokens: number | null;
            tokensSettledAt: Date | null;
          };
        },
        unknown,
      ]
    >;
    expect(transitionCalls[0][0]).toMatchObject({
      toStatus: 'FAILED',
      data: {
        errorCode: 'PROVIDER_RECONCILIATION_REQUIRED',
        errorRetryable: false,
        providerRequestIds: ['chatcmpl_checkpoint_123'],
        totalTokens: 15,
      },
    });
    expect(transitionCalls[0][1]).toBe(transaction);
  });

  it('does not call the LLM when a retry finds a request-only provider checkpoint', async () => {
    const { analysisJobService, llmProvider, service, transaction } =
      createFixture({
        reservedTokens: 20,
        providerCheckpoint: {
          providerRequestId: 'chatcmpl_unknown_usage',
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
        },
      });

    await service.runAnalysisJob({} as never, jobContext);

    expect(llmProvider.analyze).not.toHaveBeenCalled();
    expect(analysisJobService.recordProviderCharge).not.toHaveBeenCalled();
    expect(transaction.user.update).not.toHaveBeenCalled();
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          toStatus: string;
          data: {
            errorCode: string;
            providerRequestIds: string[];
            totalTokens: number | null;
            tokensSettledAt: Date | null;
          };
        },
        unknown,
      ]
    >;
    expect(transitionCalls[0][0]).toMatchObject({
      toStatus: 'FAILED',
      data: {
        errorCode: 'PROVIDER_RECONCILIATION_REQUIRED',
        providerRequestIds: ['chatcmpl_unknown_usage'],
        totalTokens: null,
        tokensSettledAt: null,
      },
    });
    expect(transitionCalls[0][1]).toBe(transaction);
  });

  it('does not call the LLM and terminates the Job when reservation fails', async () => {
    const { analysisJobService, llmProvider, service, transaction } =
      createFixture({ availableTokens: 0, tokenUpdateCount: 0 });

    const result = await service.runAnalysisJob({} as never, jobContext);

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
    expect(result.outcome).toBe(
      AnalysisJobExecutionOutcome.INSUFFICIENT_TOKENS,
    );
    if (result.outcome !== AnalysisJobExecutionOutcome.INSUFFICIENT_TOKENS) {
      throw new Error('Expected an insufficient-token execution result.');
    }
    expect(result.error).toBeInstanceOf(InsufficientAnalysisTokensError);
  });

  it('propagates insufficient tokens from the synchronous entry point after terminating the Job', async () => {
    const { analysisJobService, llmProvider, service } = createFixture({
      availableTokens: 0,
      tokenUpdateCount: 0,
    });

    await expect(service.runAnalysis(7, 9, {} as never)).rejects.toBeInstanceOf(
      InsufficientAnalysisTokensError,
    );

    expect(llmProvider.analyze).not.toHaveBeenCalled();
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<[{ toStatus: string; data?: object }]>;
    expect(transitionCalls.map(([input]) => input.toStatus)).toEqual([
      'RUNNING',
      'FAILED',
    ]);
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

  it('settles known usage and prevents retry when billed JSON parsing fails', async () => {
    const { analysisJobService, service, transaction } = createFixture({
      reservedTokens: 20,
      analyzeError: new LlmProviderReconciliationError(
        'chatcmpl_invalid_json',
        { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      ),
    });

    await service.runAnalysisJob({} as never, jobContext);

    expect(analysisJobService.recordProviderCharge).toHaveBeenCalledWith({
      jobId: 'job-1',
      expectedLeaseToken: 'lease-1',
      expectedUserId: 7,
      expectedRepositoryId: 9,
      expectedReservedTokens: 20,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      providerRequestId: 'chatcmpl_invalid_json',
    });
    expect(transaction.analysisReport.create).not.toHaveBeenCalled();
    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { availableTokens: { increment: 5 } },
    });
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          toStatus: string;
          data: {
            errorCode: string;
            errorRetryable: boolean;
            providerRequestIds: string[];
            totalTokens: number | null;
            tokensSettledAt: Date | null;
          };
        },
        unknown,
      ]
    >;
    expect(transitionCalls[0][0]).toMatchObject({
      toStatus: 'FAILED',
      data: {
        errorCode: 'PROVIDER_RECONCILIATION_REQUIRED',
        errorRetryable: false,
        providerRequestIds: ['chatcmpl_invalid_json'],
        totalTokens: 15,
      },
    });
    expect(
      analysisJobService.recordProviderCharge.mock.invocationCallOrder[0],
    ).toBeLessThan(analysisJobService.transition.mock.invocationCallOrder[0]);
  });

  it('keeps the reservation and prevents retry when billed usage is unknown', async () => {
    const { analysisJobService, service, transaction } = createFixture({
      reservedTokens: 20,
      analyzeError: new LlmProviderReconciliationError(
        'chatcmpl_missing_usage',
        null,
      ),
    });

    await service.runAnalysisJob({} as never, jobContext);

    expect(analysisJobService.recordProviderCharge).toHaveBeenCalledWith({
      jobId: 'job-1',
      expectedLeaseToken: 'lease-1',
      expectedUserId: 7,
      expectedRepositoryId: 9,
      expectedReservedTokens: 20,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      providerRequestId: 'chatcmpl_missing_usage',
    });
    expect(transaction.analysisReport.create).not.toHaveBeenCalled();
    expect(transaction.user.update).not.toHaveBeenCalled();
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          toStatus: string;
          expectedReservedTokens: number;
          data: {
            errorCode: string;
            errorRetryable: boolean;
            providerRequestIds: string[];
            totalTokens: number | null;
            tokensSettledAt: Date | null;
          };
        },
        unknown,
      ]
    >;
    expect(transitionCalls[0][0]).toMatchObject({
      toStatus: 'FAILED',
      expectedReservedTokens: 20,
      data: {
        errorCode: 'PROVIDER_RECONCILIATION_REQUIRED',
        errorRetryable: false,
        providerRequestIds: ['chatcmpl_missing_usage'],
        totalTokens: null,
        tokensSettledAt: null,
      },
    });
    expect(
      analysisJobService.recordProviderCharge.mock.invocationCallOrder[0],
    ).toBeLessThan(analysisJobService.transition.mock.invocationCallOrder[0]);
  });

  it('atomically charges usage above the reservation before settling the Job', async () => {
    const { analysisJobService, service, transaction } = createFixture({
      reservedTokens: 20,
      actualUsage: {
        promptTokens: 15,
        completionTokens: 10,
        totalTokens: 25,
      },
      tokenUpdateCount: 1,
    });

    await service.runAnalysisJob({} as never, jobContext);

    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 7, availableTokens: { gte: 5 } },
      data: { availableTokens: { decrement: 5 } },
    });
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          toStatus: string;
          data: {
            errorCode: string;
            totalTokens: number;
            tokensSettledAt: Date;
          };
        },
        unknown,
      ]
    >;
    expect(transitionCalls[0][0]).toMatchObject({
      toStatus: 'FAILED',
      data: {
        errorCode: 'TOKEN_BUDGET_EXCEEDED',
        totalTokens: 25,
      },
    });
    expect(transitionCalls[0][0].data.tokensSettledAt).toBeInstanceOf(Date);
    expect(transitionCalls[0][1]).toBe(transaction);
  });

  it('leaves above-reservation usage unsettled when the additional debit fails', async () => {
    const { analysisJobService, service, transaction } = createFixture({
      reservedTokens: 20,
      actualUsage: {
        promptTokens: 15,
        completionTokens: 10,
        totalTokens: 25,
      },
      tokenUpdateCount: 0,
    });

    await service.runAnalysisJob({} as never, jobContext);

    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          toStatus: string;
          data: {
            errorCode: string;
            totalTokens: number;
            tokensSettledAt: Date | null;
          };
        },
        unknown,
      ]
    >;
    expect(transitionCalls[0][0]).toMatchObject({
      toStatus: 'FAILED',
      data: {
        errorCode: 'PROVIDER_RECONCILIATION_REQUIRED',
        totalTokens: 25,
        tokensSettledAt: null,
      },
    });
    expect(transaction.user.update).not.toHaveBeenCalled();
  });

  it('durably reconciles a billed failure from the synchronous entry point', async () => {
    const providerError = new LlmProviderReconciliationError(
      'chatcmpl_sync_missing_usage',
      null,
    );
    const { analysisJobService, service } = createFixture({
      analyzeError: providerError,
    });

    await expect(service.runAnalysis(7, 9, {} as never)).rejects.toBe(
      providerError,
    );

    expect(analysisJobService.recordProviderCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        providerRequestId: 'chatcmpl_sync_missing_usage',
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      }),
    );
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<[{ toStatus: string; data?: object }]>;
    expect(transitionCalls.map(([input]) => input.toStatus)).toEqual([
      'RUNNING',
      'FAILED',
    ]);
  });

  it('refunds the full reservation and terminates an unbilled provider failure', async () => {
    const providerError = new Error('OpenAI network unavailable');
    const { analysisJobService, service, transaction } = createFixture({
      reservedTokens: 20,
      analyzeError: providerError,
    });

    const result = await service.runAnalysisJob({} as never, jobContext);

    expect(result).toEqual({
      outcome: AnalysisJobExecutionOutcome.ANALYSIS_FAILED,
      error: providerError,
    });
    expect(transaction.analysisReport.create).not.toHaveBeenCalled();
    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { availableTokens: { increment: 20 } },
    });
    expect(analysisJobService.recordProviderCharge).not.toHaveBeenCalled();
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          toStatus: string;
          data: {
            errorCode: string;
            providerRequestIds: string[];
            totalTokens: number;
            tokensSettledAt: Date | null;
          };
        },
        unknown,
      ]
    >;
    expect(transitionCalls[0][0]).toMatchObject({
      toStatus: 'FAILED',
      data: {
        errorCode: 'ANALYSIS_FAILED',
        providerRequestIds: [],
        totalTokens: 0,
      },
    });
    expect(transitionCalls[0][0].data.tokensSettledAt).toBeInstanceOf(Date);
    expect(transitionCalls[0][1]).toBe(transaction);
  });

  it('does not leave a reservation when OPENAI_API_KEY is missing', async () => {
    const providerError = new Error(
      'OPENAI_API_KEY not found. LLM Analysis cannot proceed.',
    );
    const { analysisJobService, service, transaction } = createFixture({
      analyzeError: providerError,
    });

    await expect(service.runAnalysis(7, 9, {} as never)).rejects.toBe(
      providerError,
    );

    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { availableTokens: { increment: 20 } },
    });
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [{ toStatus: string; data?: { errorCode?: string } }]
    >;
    expect(transitionCalls.map(([input]) => input.toStatus)).toEqual([
      'RUNNING',
      'FAILED',
    ]);
    expect(transitionCalls[1][0].data?.errorCode).toBe('ANALYSIS_FAILED');
  });

  it('returns a non-retryable error when a failed provider response cannot be checkpointed or terminated', async () => {
    const { analysisJobService, service } = createFixture({
      reservedTokens: 20,
      analyzeError: new LlmProviderReconciliationError(
        'chatcmpl_unpersisted',
        null,
      ),
    });
    analysisJobService.recordProviderCharge.mockRejectedValue(
      new Error('checkpoint unavailable'),
    );
    analysisJobService.transition.mockRejectedValue(
      new Error('terminal CAS unavailable'),
    );

    await expect(
      service.runAnalysisJob({} as never, jobContext),
    ).rejects.toMatchObject({
      name: PostBillingAnalysisPersistenceError.name,
      retryable: false,
      jobId: 'job-1',
      providerRequestId: 'chatcmpl_unpersisted',
      usage: null,
    });
  });

  it('quarantines a billed response when final result persistence fails', async () => {
    const { analysisJobService, service, transaction } = createFixture({
      reservedTokens: 20,
      reportError: new Error('database unavailable'),
    });

    await service.runAnalysisJob({} as never, jobContext);

    expect(analysisJobService.recordProviderCharge).toHaveBeenCalled();
    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { availableTokens: { increment: 5 } },
    });
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [
        {
          toStatus: string;
          data: {
            errorCode: string;
            errorRetryable: boolean;
            providerRequestIds: string[];
            totalTokens: number;
          };
        },
        unknown,
      ]
    >;
    expect(transitionCalls[0][0]).toMatchObject({
      toStatus: 'FAILED',
      data: {
        errorCode: 'PROVIDER_RECONCILIATION_REQUIRED',
        errorRetryable: false,
        providerRequestIds: ['chatcmpl_actual_123'],
        totalTokens: 15,
      },
    });
    expect(transitionCalls[0][1]).toBe(transaction);
  });

  it('uses a separate reconciliation CAS after a stale success CAS', async () => {
    const { analysisJobService, service } = createFixture({
      reservedTokens: 20,
    });
    analysisJobService.transition.mockRejectedValueOnce(
      new Error('stale lease'),
    );

    await service.runAnalysisJob({} as never, jobContext);

    expect(analysisJobService.transition).toHaveBeenCalledTimes(2);
    const transitionCalls = analysisJobService.transition.mock
      .calls as unknown as Array<
      [{ toStatus: string; data: { errorCode?: string } }]
    >;
    expect(transitionCalls[0][0].toStatus).toBe('SUCCEEDED');
    expect(transitionCalls[1][0]).toMatchObject({
      toStatus: 'FAILED',
      data: { errorCode: 'PROVIDER_RECONCILIATION_REQUIRED' },
    });
  });

  it('returns a non-retryable structured error when reconciliation CAS is also stale', async () => {
    const { analysisJobService, service } = createFixture({
      reservedTokens: 20,
    });
    analysisJobService.transition.mockRejectedValue(new Error('stale lease'));

    await expect(
      service.runAnalysisJob({} as never, jobContext),
    ).rejects.toMatchObject({
      name: PostBillingAnalysisPersistenceError.name,
      retryable: false,
      jobId: 'job-1',
      providerRequestId: 'chatcmpl_actual_123',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });
});
