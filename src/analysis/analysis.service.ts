import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RefinerService } from './refiner.service';
import { PreprocessorService } from './preprocessor.service';
import { LlmProviderService } from './llm-provider.service';
import { MetricCalculatorService } from './metric-calculator.service';
import { StatService } from './stat.service';
import { CollectedDataDto } from '../collection/types/github-api.types';
import { Prisma } from '@prisma/client';

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
   * 특정 사용자와 저장소에 대한 전체 분석 파이프라인 실행
   */
  async runAnalysis(
    userId: number,
    repositoryId: number,
    data: CollectedDataDto,
  ) {
    this.logger.log(
      `Starting analysis for User ${userId}, Repo ${repositoryId}...`,
    );

    // 0. 사용자 토큰 잔액 확인
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
      // 1. 데이터 정제
      const refinedData = this.refiner.refine(data);
      if (refinedData.pullRequests.length === 0) {
        this.logger.warn('No meaningful data to analyze after refinement.');
        return;
      }

      // 2. 데이터 전처리
      const preprocessedData = this.preprocessor.preprocess(refinedData);

      // 3. LLM 분석
      const llmResponse = await this.llmProvider.analyze(preprocessedData);
      const { result: llmResult, usage } = llmResponse;

      // 4. 최종 지표 계산
      const metrics = this.calculator.calculate(llmResult);

      // 5. 트랜잭션 내에서 리포트 저장, 통계 업데이트 및 토큰 차감 진행
      await this.prisma.$transaction(async (tx) => {
        // A. 리포트 저장
        await tx.analysisReport.create({
          data: {
            userId,
            repositoryId,
            metrics: llmResult as unknown as Prisma.InputJsonValue,
          },
        });

        // B. 사용자 통계 업데이트
        await this.statService.updateStats(userId, metrics);

        // C. 토큰 차감
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
   * 데이터 분석에 필요한 정확한 토큰 수 사전 계산
   */
  estimateTokens(data: CollectedDataDto): {
    prCount: number;
    estimatedTokens: number;
  } {
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
   * 사용자의 통합 통계 조회
   */
  async getUserStats(userId: number) {
    return this.prisma.userStat.findUnique({
      where: { userId },
    });
  }

  /**
   * 사용자의 모든 리포트 조회 (공유 상태 필터링 옵션 포함)
   */
  async getReports(userId: number, isShared?: boolean) {
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
   * 특정 저장소의 모든 리포트 조회
   */
  async getReportsByRepository(userId: number, repositoryId: number) {
    return await this.prisma.analysisReport.findMany({
      where: { userId, repositoryId },
      include: { repository: true },
      orderBy: { syncTime: 'desc' },
    });
  }

  /**
   * ID로 특정 리포트 조회 (소유권 검증 포함)
   */
  async getReportById(id: number, userId: number) {
    return await this.prisma.analysisReport.findFirst({
      where: { id, userId },
      include: { repository: true },
    });
  }

  /**
   * 최소 하나 이상의 분석 리포트가 있는 저장소 목록 및 최신 리포트 조회
   */
  async getAnalyzedRepositories(userId: number) {
    // 1. 이 사용자의 리포트가 존재하는 고유한 저장소 ID 목록 조회
    const reports = await this.prisma.analysisReport.findMany({
      where: { userId },
      select: { repositoryId: true },
      distinct: ['repositoryId'],
    });

    if (reports.length === 0) return [];

    // 2. 각 저장소별 최신 리포트 조회
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
   * 특정 리포트를 사용자의 대표 분석 결과로 설정
   */
  async setRepresentative(userId: number, reportId: number) {
    // 리포트 소유권 검증
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
   * 특정 리포트의 공유 상태 토글
   */
  async toggleSharing(userId: number, reportId: number, isShared: boolean) {
    // 리포트 소유권 검증
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
   * 사용자 이름으로 공개 대표 리포트 조회
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
   * 플랫폼 전체의 모든 공유된 대표 리포트 조회
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
