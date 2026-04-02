import { PrismaService } from '../prisma/prisma.service';
import { RefinerService } from './refiner.service';
import { PreprocessorService } from './preprocessor.service';
import { LlmProviderService } from './llm-provider.service';
import { MetricCalculatorService } from './metric-calculator.service';
import { StatService } from './stat.service';
import { CollectedDataDto } from '../collection/types/github-api.types';
export declare class AnalysisService {
    private prisma;
    private refiner;
    private preprocessor;
    private llmProvider;
    private calculator;
    private statService;
    private readonly logger;
    constructor(prisma: PrismaService, refiner: RefinerService, preprocessor: PreprocessorService, llmProvider: LlmProviderService, calculator: MetricCalculatorService, statService: StatService);
    runAnalysis(userId: number, repositoryId: number, data: CollectedDataDto): Promise<{
        actionableScore: number;
        feedbackAcceptScore: number;
        avgCycleTimeHours: number;
        logicScore: number;
        architectureScore: number;
        dbScore: number;
        infraScore: number;
    } | undefined>;
    getUserStats(userId: number): Promise<any>;
    getReports(userId: number): Promise<any>;
    getReportById(id: number, userId: number): Promise<any>;
}
