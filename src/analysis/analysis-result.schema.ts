import { z } from 'zod';

export const ANALYSIS_METRIC_KEYS = [
  'mutual_respect',
  'conflict_management',
  'logical_problem_definition',
  'review_guiding',
  'documentation',
  'knowledge_sharing',
  'technical_influence',
  'code_stability',
] as const;

export type AnalysisMetricKey = (typeof ANALYSIS_METRIC_KEYS)[number];

export const analysisEvidenceSchema = z
  .object({
    prNumber: z.number().int().positive(),
    permalink: z
      .string()
      .min(1)
      .max(500)
      .regex(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/),
    author: z.string().trim().min(1).max(100),
    quote: z.string().trim().min(1).max(2000),
  })
  .strict();

export const metricEvaluationSchema = z
  .object({
    score: z.number().finite().min(1).max(5).multipleOf(0.5),
    reason: z.string().trim().min(1).max(4000),
    improvement: z.string().trim().min(1).max(2000),
    example: z.string().trim().min(1).max(3000),
    evidence: z.array(analysisEvidenceSchema).max(12),
  })
  .strict();

export const analysisResultSchema = z
  .object({
    mutual_respect: metricEvaluationSchema,
    conflict_management: metricEvaluationSchema,
    logical_problem_definition: metricEvaluationSchema,
    review_guiding: metricEvaluationSchema,
    documentation: metricEvaluationSchema,
    knowledge_sharing: metricEvaluationSchema,
    technical_influence: metricEvaluationSchema,
    code_stability: metricEvaluationSchema,
    summary: z.string().trim().min(1).max(3000),
  })
  .strict();

export type AnalysisEvidence = z.infer<typeof analysisEvidenceSchema>;
export type MetricEvaluation = z.infer<typeof metricEvaluationSchema>;
export type LlmAnalysisResult = z.infer<typeof analysisResultSchema>;
