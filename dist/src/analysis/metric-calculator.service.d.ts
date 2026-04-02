import { LlmAnalysisResult } from './llm-provider.service';
export declare class MetricCalculatorService {
    calculate(llmResult: LlmAnalysisResult): {
        actionableScore: number;
        feedbackAcceptScore: number;
        avgCycleTimeHours: number;
        logicScore: number;
        architectureScore: number;
        dbScore: number;
        infraScore: number;
    };
    private mapAcceptanceToScore;
}
