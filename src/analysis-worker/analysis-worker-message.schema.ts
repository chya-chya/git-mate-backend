import { z } from 'zod';

const NORMALIZED_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const analysisWorkerMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: z.string().regex(NORMALIZED_UUID_PATTERN),
  })
  .strict();

export interface AnalysisWorkerMessage {
  schemaVersion: 1;
  jobId: string;
}

export type AnalysisWorkerMessageParseResult =
  | { kind: 'VALID'; message: AnalysisWorkerMessage }
  | { kind: 'INVALID'; jobId: string | null };

export function parseAnalysisWorkerMessage(
  body: string,
): AnalysisWorkerMessageParseResult {
  let input: unknown;
  try {
    input = JSON.parse(body) as unknown;
  } catch {
    return { kind: 'INVALID', jobId: null };
  }

  const jobId = extractNormalizedJobId(input);
  const parsed = analysisWorkerMessageSchema.safeParse(input);
  if (!parsed.success) {
    return { kind: 'INVALID', jobId };
  }

  return { kind: 'VALID', message: parsed.data };
}

function extractNormalizedJobId(input: unknown): string | null {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    !('jobId' in input)
  ) {
    return null;
  }
  const jobId: unknown = input.jobId;
  return typeof jobId === 'string' && NORMALIZED_UUID_PATTERN.test(jobId)
    ? jobId
    : null;
}
