import { Injectable, Logger } from '@nestjs/common';
import { AnalysisJobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RefinerService } from './refiner.service';
import { PreprocessorService } from './preprocessor.service';
import { LlmProviderService } from './llm-provider.service';
import { MetricCalculatorService } from './metric-calculator.service';
import { StatService } from './stat.service';
import { CollectedDataDto } from '../collection/types/github-api.types';
import {
  AnalysisJobFailureCode,
  AnalysisJobService,
} from '../analysis-job/analysis-job.service';

export interface AnalysisJobExecutionContext {
  jobId: string;
  leaseToken: string;
  providerRequestIds: string[];
}

interface ResolvedAnalysisJobExecutionContext extends AnalysisJobExecutionContext {
  reservedTokens: number | null;
}

interface AnalysisTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const ZERO_TOKEN_USAGE: AnalysisTokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

export class InsufficientAnalysisTokensError extends Error {
  constructor() {
    super('Insufficient tokens to settle the analysis result.');
    this.name = InsufficientAnalysisTokensError.name;
  }
}

export class InvalidAnalysisTokenUsageError extends Error {
  constructor() {
    super('Analysis token usage is invalid.');
    this.name = InvalidAnalysisTokenUsageError.name;
  }
}

export class AnalysisTokenBudgetExceededError extends Error {
  constructor() {
    super('Analysis token usage exceeded its reserved budget.');
    this.name = AnalysisTokenBudgetExceededError.name;
  }
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private prisma: PrismaService,
    private refiner: RefinerService,
    private preprocessor: PreprocessorService,
    private llmProvider: LlmProviderService,
    private calculator: MetricCalculatorService,
    private statService: StatService,
    private analysisJobService: AnalysisJobService,
  ) {}

  /**
   * Run the full analysis pipeline for a specific user and repository
   */
  runAnalysis(userId: number, repositoryId: number, data: CollectedDataDto) {
    return this.executeAnalysis(userId, repositoryId, data);
  }

  /**
   * Run the worker pipeline and atomically commit its durable job result.
   */
  async runAnalysisJob(
    data: CollectedDataDto,
    jobContext: AnalysisJobExecutionContext,
  ) {
    const job = await this.analysisJobService.getRunningJobContext(
      jobContext.jobId,
      jobContext.leaseToken,
    );
    return this.executeAnalysis(job.userId, job.repositoryId, data, {
      ...jobContext,
      reservedTokens: job.reservedTokens,
    });
  }

  private async executeAnalysis(
    userId: number,
    repositoryId: number,
    data: CollectedDataDto,
    jobContext?: ResolvedAnalysisJobExecutionContext,
  ) {
    this.logger.log(
      `Starting analysis for User ${userId}, Repo ${repositoryId}...`,
    );

    // 0. Check User Token Balance
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { availableTokens: true },
    });

    if (!user) {
      throw new Error(`User with ID ${userId} not found.`);
    }

    if (jobContext === undefined && user.availableTokens <= 0) {
      throw new Error(
        `Insufficient tokens. Available: ${user.availableTokens}. Please recharge your tokens.`,
      );
    }

    try {
      // 1. Refine Data
      const refinedData = this.refiner.refine(data);
      if (refinedData.pullRequests.length === 0) {
        this.logger.warn('No meaningful data to analyze after refinement.');
        if (jobContext !== undefined) {
          await this.terminateWorkerJob(
            userId,
            repositoryId,
            jobContext,
            AnalysisJobFailureCode.NO_ANALYZABLE_DATA,
            ZERO_TOKEN_USAGE,
            jobContext.reservedTokens ?? 0,
          );
        }
        return;
      }

      // 2. Preprocess Data
      const preprocessedData = this.preprocessor.preprocess(refinedData);

      let reservedTokens: number | null = null;
      if (jobContext !== undefined) {
        const reservation =
          this.llmProvider.estimateTokenReservationForData(preprocessedData);
        try {
          reservedTokens = await this.ensureWorkerTokenReservation(
            userId,
            repositoryId,
            jobContext,
            reservation,
          );
        } catch (error) {
          if (error instanceof InsufficientAnalysisTokensError) {
            await this.terminateWorkerJob(
              userId,
              repositoryId,
              jobContext,
              AnalysisJobFailureCode.INSUFFICIENT_TOKENS,
              ZERO_TOKEN_USAGE,
              0,
            );
            return;
          }
          if (error instanceof AnalysisTokenBudgetExceededError) {
            await this.terminateWorkerJob(
              userId,
              repositoryId,
              jobContext,
              AnalysisJobFailureCode.TOKEN_BUDGET_EXCEEDED,
              ZERO_TOKEN_USAGE,
              jobContext.reservedTokens ?? 0,
            );
            return;
          }
          throw error;
        }
      }

      // 3. LLM Analysis
      const llmResponse = await this.llmProvider.analyze(preprocessedData);
      const { result: llmResult, usage } = llmResponse;
      this.assertValidTokenUsage(usage);
      if (
        jobContext !== undefined &&
        reservedTokens !== null &&
        usage.totalTokens > reservedTokens
      ) {
        await this.terminateWorkerJob(
          userId,
          repositoryId,
          jobContext,
          AnalysisJobFailureCode.TOKEN_BUDGET_EXCEEDED,
          usage,
          0,
        );
        return;
      }

      // 4. Calculate Final Metrics
      const metrics = this.calculator.calculate(llmResult);

      // 5. Save Report, Update Stats, and Deduct Tokens in a Transaction
      await this.prisma.$transaction(async (tx) => {
        // A. Save Report
        const report = await tx.analysisReport.create({
          data: {
            userId,
            repositoryId,
            metrics: llmResult as unknown as Prisma.InputJsonValue,
            ...(jobContext === undefined ? {} : { jobId: jobContext.jobId }),
          },
        });

        // B. Update User Stats
        await this.statService.updateStats(userId, metrics, tx);

        // C. Deduct Tokens
        if (reservedTokens === null) {
          const tokenSettlement = await tx.user.updateMany({
            where: {
              id: userId,
              availableTokens: { gte: usage.totalTokens },
            },
            data: {
              availableTokens: {
                decrement: usage.totalTokens,
              },
            },
          });
          if (tokenSettlement.count !== 1) {
            throw new InsufficientAnalysisTokensError();
          }
        } else {
          const refundTokens = reservedTokens - usage.totalTokens;
          if (refundTokens > 0) {
            await tx.user.update({
              where: { id: userId },
              data: { availableTokens: { increment: refundTokens } },
            });
          }
        }

        if (jobContext !== undefined) {
          if (reservedTokens === null) {
            throw new InvalidAnalysisTokenUsageError();
          }
          const completedAt = new Date();
          await this.analysisJobService.transition(
            {
              jobId: jobContext.jobId,
              fromStatus: AnalysisJobStatus.RUNNING,
              toStatus: AnalysisJobStatus.SUCCEEDED,
              expectedLeaseToken: jobContext.leaseToken,
              expectedUserId: userId,
              expectedRepositoryId: repositoryId,
              expectedReservedTokens: reservedTokens,
              data: {
                reportId: report.id,
                completedAt,
                tokensSettledAt: completedAt,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                providerRequestIds: jobContext.providerRequestIds,
              },
            },
            tx,
          );
        }

        this.logger.log(
          `Deducted ${usage.totalTokens} tokens from User ${userId}.`,
        );
      });

      this.logger.log('Analysis completed successfully.');
      return metrics;
    } catch (error) {
      this.logger.error('Analysis failed', error);
      throw error;
    }
  }

  private async ensureWorkerTokenReservation(
    userId: number,
    repositoryId: number,
    jobContext: ResolvedAnalysisJobExecutionContext,
    reservation: { estimatedTokens: number; reservedTokens: number },
  ): Promise<number> {
    this.assertValidReservation(reservation);
    if (jobContext.reservedTokens !== null) {
      if (jobContext.reservedTokens < reservation.reservedTokens) {
        throw new AnalysisTokenBudgetExceededError();
      }
      return jobContext.reservedTokens;
    }

    await this.prisma.$transaction(async (tx) => {
      const debit = await tx.user.updateMany({
        where: {
          id: userId,
          availableTokens: { gte: reservation.reservedTokens },
        },
        data: {
          availableTokens: { decrement: reservation.reservedTokens },
        },
      });
      if (debit.count !== 1) {
        throw new InsufficientAnalysisTokensError();
      }
      await this.analysisJobService.reserveTokens(
        {
          jobId: jobContext.jobId,
          expectedLeaseToken: jobContext.leaseToken,
          expectedUserId: userId,
          expectedRepositoryId: repositoryId,
          estimatedTokens: reservation.estimatedTokens,
          reservedTokens: reservation.reservedTokens,
        },
        tx,
      );
    });
    jobContext.reservedTokens = reservation.reservedTokens;
    return reservation.reservedTokens;
  }

  private async terminateWorkerJob(
    userId: number,
    repositoryId: number,
    jobContext: ResolvedAnalysisJobExecutionContext,
    errorCode: AnalysisJobFailureCode,
    usage: AnalysisTokenUsage,
    refundTokens: number,
  ): Promise<void> {
    const completedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (refundTokens > 0) {
        await tx.user.update({
          where: { id: userId },
          data: { availableTokens: { increment: refundTokens } },
        });
      }
      await this.analysisJobService.transition(
        {
          jobId: jobContext.jobId,
          fromStatus: AnalysisJobStatus.RUNNING,
          toStatus: AnalysisJobStatus.FAILED,
          expectedLeaseToken: jobContext.leaseToken,
          expectedUserId: userId,
          expectedRepositoryId: repositoryId,
          expectedReservedTokens: jobContext.reservedTokens,
          data: {
            completedAt,
            tokensSettledAt: completedAt,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            providerRequestIds: jobContext.providerRequestIds,
            errorCode,
            errorRetryable: false,
          },
        },
        tx,
      );
    });
  }

  private assertValidReservation(reservation: {
    estimatedTokens: number;
    reservedTokens: number;
  }): void {
    if (
      !Number.isSafeInteger(reservation.estimatedTokens) ||
      reservation.estimatedTokens < 0 ||
      !Number.isSafeInteger(reservation.reservedTokens) ||
      reservation.reservedTokens < reservation.estimatedTokens
    ) {
      throw new InvalidAnalysisTokenUsageError();
    }
  }

  private assertValidTokenUsage(usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }): void {
    if (
      !Number.isSafeInteger(usage.promptTokens) ||
      usage.promptTokens < 0 ||
      !Number.isSafeInteger(usage.completionTokens) ||
      usage.completionTokens < 0 ||
      !Number.isSafeInteger(usage.totalTokens) ||
      usage.totalTokens < 0 ||
      usage.promptTokens + usage.completionTokens !== usage.totalTokens
    ) {
      throw new InvalidAnalysisTokenUsageError();
    }
  }

  /**
   * Pre-calculate the exact tokens required for the data analysis.
   */
  estimateTokens(data: CollectedDataDto): Promise<{
    prCount: number;
    estimatedTokens: number;
  }> {
    const refinedData = this.refiner.refine(data);
    const prCount = refinedData.pullRequests.length;
    if (prCount === 0) {
      return Promise.resolve({ prCount: 0, estimatedTokens: 0 });
    }
    const preprocessedData = this.preprocessor.preprocess(refinedData);
    const estimatedTokens =
      this.llmProvider.estimateTokensForData(preprocessedData);
    return Promise.resolve({ prCount, estimatedTokens });
  }

  /**
   * Get aggregate stats for a user
   */
  getUserStats(userId: number) {
    return this.prisma.userStat.findUnique({
      where: { userId },
    });
  }

  /**
   * Get all reports for a user, optionally filtered by shared status
   */
  getReports(userId: number, isShared?: boolean) {
    const whereClause: Prisma.AnalysisReportWhereInput = { userId };
    if (isShared !== undefined) {
      whereClause.isShared = isShared;
    }

    return this.prisma.analysisReport.findMany({
      where: whereClause,
      include: { repository: true },
      orderBy: { syncTime: 'desc' },
    });
  }

  /**
   * Get all reports for a specific repository
   */
  getReportsByRepository(userId: number, repositoryId: number) {
    return this.prisma.analysisReport.findMany({
      where: { userId, repositoryId },
      include: { repository: true },
      orderBy: { syncTime: 'desc' },
    });
  }

  /**
   * Get a specific report by ID, verifying ownership
   */
  getReportById(id: number, userId: number) {
    return this.prisma.analysisReport.findFirst({
      where: { id, userId },
      include: { repository: true },
    });
  }

  /**
   * Get list of repositories that have at least one analysis report, with the latest report
   */
  async getAnalyzedRepositories(userId: number) {
    // 1. Get unique repository IDs that have reports for this user
    const reports = await this.prisma.analysisReport.findMany({
      where: { userId },
      select: { repositoryId: true },
      distinct: ['repositoryId'],
    });

    if (reports.length === 0) return [];

    // 2. For each repository, get the latest report
    const summaries = await Promise.all(
      reports.map(async (report) => {
        const latestReport = await this.prisma.analysisReport.findFirst({
          where: { userId, repositoryId: report.repositoryId },
          include: { repository: true },
          orderBy: { syncTime: 'desc' },
        });
        return latestReport;
      }),
    );

    return summaries;
  }

  /**
   * Set a specific report as the representative one for the user
   */
  async setRepresentative(userId: number, reportId: number) {
    // Verify report ownership
    const report = await this.prisma.analysisReport.findFirst({
      where: { id: reportId, userId },
    });
    if (!report) {
      throw new Error(
        `Report with ID ${reportId} not found or not owned by User ${userId}`,
      );
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { representativeReportId: reportId },
    });
  }

  /**
   * Toggle sharing status of a specific report
   */
  async toggleSharing(userId: number, reportId: number, isShared: boolean) {
    // Verify report ownership
    const report = await this.prisma.analysisReport.findFirst({
      where: { id: reportId, userId },
    });
    if (!report) {
      throw new Error(
        `Report with ID ${reportId} not found or not owned by User ${userId}`,
      );
    }

    return this.prisma.analysisReport.update({
      where: { id: reportId },
      data: { isShared },
    });
  }

  /**
   * Get public representative report by username
   */
  async getPublicReport(username: string) {
    const user = await this.prisma.user.findFirst({
      where: { username },
      include: {
        representativeReport: {
          include: { repository: true },
        },
      },
    });

    if (
      !user ||
      !user.representativeReport ||
      !user.representativeReport.isShared
    ) {
      return null;
    }

    return user.representativeReport;
  }

  /**
   * Get all shared representative reports across the platform
   */
  getAllPublicReports() {
    return this.prisma.user.findMany({
      where: {
        representativeReport: {
          isShared: true,
        },
      },
      select: {
        id: true,
        username: true,
        avatarUrl: true,
        representativeReport: {
          include: { repository: true },
        },
      },
      orderBy: {
        representativeReport: {
          syncTime: 'desc',
        },
      },
    });
  }
}
