"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var AnalysisService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalysisService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
const refiner_service_1 = require("./refiner.service");
const preprocessor_service_1 = require("./preprocessor.service");
const llm_provider_service_1 = require("./llm-provider.service");
const metric_calculator_service_1 = require("./metric-calculator.service");
const stat_service_1 = require("./stat.service");
let AnalysisService = AnalysisService_1 = class AnalysisService {
    prisma;
    refiner;
    preprocessor;
    llmProvider;
    calculator;
    statService;
    logger = new common_1.Logger(AnalysisService_1.name);
    constructor(prisma, refiner, preprocessor, llmProvider, calculator, statService) {
        this.prisma = prisma;
        this.refiner = refiner;
        this.preprocessor = preprocessor;
        this.llmProvider = llmProvider;
        this.calculator = calculator;
        this.statService = statService;
    }
    async runAnalysis(userId, repositoryId, data) {
        this.logger.log(`Starting analysis for User ${userId}, Repo ${repositoryId}...`);
        try {
            const refinedData = this.refiner.refine(data);
            if (refinedData.pullRequests.length === 0) {
                this.logger.warn('No meaningful data to analyze after refinement.');
                return;
            }
            const preprocessedData = this.preprocessor.preprocess(refinedData);
            const llmResult = await this.llmProvider.analyze(preprocessedData);
            const metrics = this.calculator.calculate(llmResult);
            await this.prisma.$transaction(async (tx) => {
                await tx.analysisReport.create({
                    data: {
                        userId,
                        repositoryId,
                        metrics: llmResult,
                    },
                });
                await this.statService.updateStats(userId, metrics);
            });
            this.logger.log('Analysis completed successfully.');
            return metrics;
        }
        catch (error) {
            this.logger.error('Analysis failed', error);
            throw error;
        }
    }
    async getUserStats(userId) {
        return this.prisma.userStat.findUnique({
            where: { userId },
        });
    }
    async getReports(userId) {
        return this.prisma.analysisReport.findMany({
            where: { userId },
            include: { repository: true },
            orderBy: { syncTime: 'desc' },
        });
    }
    async getReportById(id, userId) {
        return this.prisma.analysisReport.findFirst({
            where: { id, userId },
            include: { repository: true },
        });
    }
};
exports.AnalysisService = AnalysisService;
exports.AnalysisService = AnalysisService = AnalysisService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        refiner_service_1.RefinerService,
        preprocessor_service_1.PreprocessorService,
        llm_provider_service_1.LlmProviderService,
        metric_calculator_service_1.MetricCalculatorService,
        stat_service_1.StatService])
], AnalysisService);
//# sourceMappingURL=analysis.service.js.map