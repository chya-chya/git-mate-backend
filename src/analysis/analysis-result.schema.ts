import { z } from 'zod';

export const ANALYSIS_RESULT_SCHEMA_VERSION = 'analysis-result-v2';

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

export const analysisEvidenceSourceTypeSchema = z.enum([
  'pull_request',
  'review',
  'review_comment',
]);

export const analysisEvidenceRelationSchema = z.enum([
  'target_authored_pr',
  'target_authored_review',
  'target_authored_review_comment',
]);

export const analysisEvidenceSchema = z
  .object({
    prNumber: z.number().int().positive(),
    permalink: z
      .string()
      .min(1)
      .max(500)
      .regex(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/),
    author: z.string().trim().min(1).max(100),
    sourceType: analysisEvidenceSourceTypeSchema,
    targetRelation: analysisEvidenceRelationSchema,
    quote: z.string().trim().min(1).max(2000),
    scoreRationale: z.string().trim().min(1).max(1000),
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

export const analysisPayloadSchema = z
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

export const analysisResultMetadataSchema = z
  .object({
    requestedModel: z.string().trim().min(1).max(100),
    responseModel: z.string().trim().min(1).max(100),
    promptVersion: z.string().trim().min(1).max(100),
    schemaVersion: z.literal(ANALYSIS_RESULT_SCHEMA_VERSION),
    generatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const analysisResultSchema = analysisPayloadSchema
  .extend({ metadata: analysisResultMetadataSchema })
  .strict();

export type AnalysisEvidence = z.infer<typeof analysisEvidenceSchema>;
export type AnalysisEvidenceSourceType = z.infer<
  typeof analysisEvidenceSourceTypeSchema
>;
export type AnalysisEvidenceRelation = z.infer<
  typeof analysisEvidenceRelationSchema
>;
export type MetricEvaluation = z.infer<typeof metricEvaluationSchema>;
export type LlmAnalysisPayload = z.infer<typeof analysisPayloadSchema>;
export type AnalysisResultMetadata = z.infer<
  typeof analysisResultMetadataSchema
>;
export type LlmAnalysisResult = z.infer<typeof analysisResultSchema>;
