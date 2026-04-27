import { Injectable } from '@nestjs/common';
import { LlmAnalysisResult } from './llm-provider.service';

@Injectable()
export class MetricCalculatorService {
  /**
   * Calculate final metrics based on LLM analysis and raw metadata
   */
  calculate(llmResult: LlmAnalysisResult) {
    return {
      mutualRespectScore: llmResult.mutual_respect * 20,
      conflictManagementScore: llmResult.conflict_management * 20,
      logicalProblemScore: llmResult.logical_problem_definition * 20,
      reviewGuidingScore: llmResult.review_guiding * 20,
      documentationScore: llmResult.documentation * 20,
      knowledgeSharingScore: llmResult.knowledge_sharing * 20,
      technicalInfluenceScore: llmResult.technical_influence * 20,
      codeStabilityScore: llmResult.code_stability * 20,
    };
  }
}
