import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RefinerService } from './refiner.service';
import { PreprocessorService } from './preprocessor.service';
import { LlmProviderService } from './llm-provider.service';
import { MetricCalculatorService } from './metric-calculator.service';
import { StatService } from './stat.service';
import { CollectedDataDto } from '../collection/types/github-api.types';

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
  ) {}

  /**
   * Run the full analysis pipeline for a specific user and repository
   */
  async runAnalysis(
    userId: number,
    repositoryId: number,
    data: CollectedDataDto,
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

    if (user.availableTokens <= 0) {
      throw new Error(
        `Insufficient tokens. Available: ${user.availableTokens}. Please recharge your tokens.`,
      );
    }

    try {
      // 1. Refine Data
      const refinedData = this.refiner.refine(data);
      if (refinedData.pullRequests.length === 0) {
        this.logger.warn('No meaningful data to analyze after refinement.');
        return;
      }

      // 2. Preprocess Data
      const preprocessedData = this.preprocessor.preprocess(refinedData);

      // 3. LLM Analysis with CAG Parallelism
      const llmResponse = await this.llmProvider.analyze(preprocessedData);
      const { result: llmResult, usage } = llmResponse;

      // 4. Calculate Final Metrics
      const metrics = this.calculator.calculate(llmResult);

      // 5. Save Report, Update Stats, and Deduct Tokens in a Transaction
      await (this.prisma as any).$transaction(async (tx) => {
        // A. Save Report
        await tx.analysisReport.create({
          data: {
            userId,
            repositoryId,
            metrics: llmResult as any,
          },
        });

        // B. Update User Stats
        await this.statService.updateStats(userId, metrics);

        // C. Deduct Tokens
        await tx.user.update({
          where: { id: userId },
          data: {
            availableTokens: {
              decrement: usage.totalTokens,
            },
          },
        });

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

  /**
   * Pre-calculate the exact tokens required for the data analysis.
   */
  async estimateTokens(
    data: CollectedDataDto,
  ): Promise<{ prCount: number; estimatedTokens: number }> {
    const refinedData = this.refiner.refine(data);
    const prCount = refinedData.pullRequests.length;
    if (prCount === 0) {
      return { prCount: 0, estimatedTokens: 0 };
    }
    const preprocessedData = this.preprocessor.preprocess(refinedData);
    const estimatedTokens =
      this.llmProvider.estimateTokensForData(preprocessedData);
    return { prCount, estimatedTokens };
  }

  /**
   * Get aggregate stats for a user
   */
  async getUserStats(userId: number) {
    return (this.prisma as any).userStat.findUnique({
      where: { userId },
    });
  }

  /**
   * Get all reports for a user, optionally filtered by shared status
   */
  async getReports(userId: number, isShared?: boolean) {
    const whereClause: any = { userId };
    if (isShared !== undefined) {
      whereClause.isShared = isShared;
    }

    return (this.prisma as any).analysisReport.findMany({
      where: whereClause,
      include: { repository: true },
      orderBy: { syncTime: 'desc' },
    });
  }

  /**
   * Get all reports for a specific repository
   */
  async getReportsByRepository(userId: number, repositoryId: number) {
    return await (this.prisma as any).analysisReport.findMany({
      where: { userId, repositoryId },
      include: { repository: true },
      orderBy: { syncTime: 'desc' },
    });
  }

  /**
   * Get a specific report by ID, verifying ownership
   */
  async getReportById(id: number, userId: number) {
    return await (this.prisma as any).analysisReport.findFirst({
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
      reports.map(async (r: any) => {
        const latestReport = await this.prisma.analysisReport.findFirst({
          where: { userId, repositoryId: r.repositoryId },
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
  async getAllPublicReports() {
    return await this.prisma.user.findMany({
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
