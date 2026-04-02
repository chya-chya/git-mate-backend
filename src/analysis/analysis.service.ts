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
  async runAnalysis(userId: number, repositoryId: number, data: CollectedDataDto) {
    this.logger.log(`Starting analysis for User ${userId}, Repo ${repositoryId}...`);

    try {
      // 1. Refine Data
      const refinedData = this.refiner.refine(data);
      if (refinedData.pullRequests.length === 0) {
        this.logger.warn('No meaningful data to analyze after refinement.');
        return;
      }

      // 2. Preprocess Data
      const preprocessedData = this.preprocessor.preprocess(refinedData);

      // 3. LLM Analysis
      const llmResult = await this.llmProvider.analyze(preprocessedData);

      // 4. Calculate Final Metrics
      const metrics = this.calculator.calculate(llmResult);

      // 5. Save Report & Update Stats in a Transaction
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
        // Note: Using a shared service with the transaction context is ideal, 
        // but for now, we'll perform a simplified update or pass tx if refactored.
        // For simplicity in this implementation, we'll use the StatService directly
        // because we're using PgAdapter which handles its own connections.
        await this.statService.updateStats(userId, metrics);
      });

      this.logger.log('Analysis completed successfully.');
      return metrics;
    } catch (error) {
      this.logger.error('Analysis failed', error);
      throw error;
    }
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
   * Get all reports for a user
   */
  async getReports(userId: number) {
    return (this.prisma as any).analysisReport.findMany({
      where: { userId },
      include: { repository: true },
      orderBy: { syncTime: 'desc' },
    });
  }

  /**
   * Get a specific report by ID, verifying ownership
   */
  async getReportById(id: number, userId: number) {
    return (this.prisma as any).analysisReport.findFirst({
      where: { id, userId },
      include: { repository: true },
    });
  }
}
