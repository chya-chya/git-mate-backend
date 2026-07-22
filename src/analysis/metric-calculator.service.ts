import { Injectable } from '@nestjs/common';
import { LlmAnalysisResult } from './llm-provider.service';

export interface AnalysisMetrics {
  mutualRespectScore: number;
  conflictManagementScore: number;
  logicalProblemScore: number;
  reviewGuidingScore: number;
  documentationScore: number;
  knowledgeSharingScore: number;
  technicalInfluenceScore: number;
  codeStabilityScore: number;
}

@Injectable()
export class MetricCalculatorService {
  /**
   * Calculate final metrics based on LLM analysis and raw metadata
   */
  calculate(llmResult: LlmAnalysisResult): AnalysisMetrics {
    return {
      mutualRespectScore: llmResult.mutual_respect.score * 20,
      conflictManagementScore: llmResult.conflict_management.score * 20,
      logicalProblemScore: llmResult.logical_problem_definition.score * 20,
      reviewGuidingScore: llmResult.review_guiding.score * 20,
      documentationScore: llmResult.documentation.score * 20,
      knowledgeSharingScore: llmResult.knowledge_sharing.score * 20,
      technicalInfluenceScore: llmResult.technical_influence.score * 20,
      codeStabilityScore: llmResult.code_stability.score * 20,
    };
  }
}
