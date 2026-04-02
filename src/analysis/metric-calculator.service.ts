import { Injectable } from '@nestjs/common';
import { LlmAnalysisResult } from './llm-provider.service';

@Injectable()
export class MetricCalculatorService {
  /**
   * Calculate final metrics based on LLM analysis and raw metadata
   */
  calculate(llmResult: LlmAnalysisResult) {
    // Currently, we use the LLM-evaluated scores directly as a baseline.
    // In the future, this can include more complex formulas using GitHub metadata (e.g. cycle time calculation).
    
    return {
      actionableScore: llmResult.actionable_score,
      feedbackAcceptScore: this.mapAcceptanceToScore(llmResult.feedback_acceptance),
      avgCycleTimeHours: llmResult.conflict_resolution_time_hours,
      logicScore: llmResult.tech_domains.business_logic,
      architectureScore: llmResult.tech_domains.architecture,
      dbScore: llmResult.tech_domains.database,
      infraScore: llmResult.tech_domains.infrastructure,
    };
  }

  private mapAcceptanceToScore(acceptance: string): number {
    const map: Record<string, number> = {
      '수용적': 100,
      '수용': 100,
      '보통': 50,
      '방어적': 20,
      '거부': 10,
    };
    return map[acceptance] || 50;
  }
}
