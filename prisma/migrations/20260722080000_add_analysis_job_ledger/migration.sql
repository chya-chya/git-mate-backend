-- CreateEnum
CREATE TYPE "AnalysisJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnalysisJobStage" AS ENUM ('WAITING', 'COLLECTING', 'RESERVING_TOKENS', 'ANALYZING', 'SAVING');

-- AlterTable
ALTER TABLE "user_stats"
ADD COLUMN "analysisCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "analysis_reports"
ADD COLUMN "jobId" TEXT;

-- CreateTable
CREATE TABLE "analysis_jobs" (
    "id" TEXT NOT NULL,
    "status" "AnalysisJobStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "AnalysisJobStage" DEFAULT 'WAITING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "userId" INTEGER NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "sourceCursor" TIMESTAMP(3),
    "modelVersion" TEXT NOT NULL DEFAULT 'legacy',
    "promptVersion" TEXT NOT NULL DEFAULT 'legacy',
    "estimatedTokens" INTEGER,
    "reservedTokens" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "tokensSettledAt" TIMESTAMP(3),
    "providerRequestIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "messagePublishedAt" TIMESTAMP(3),
    "nextPublishAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "errorRetryable" BOOLEAN,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "analysis_jobs_progress_check" CHECK ("progress" BETWEEN 0 AND 100),
    CONSTRAINT "analysis_jobs_publish_attempts_check" CHECK ("publishAttempts" >= 0),
    CONSTRAINT "analysis_jobs_attempt_count_check" CHECK ("attemptCount" >= 0),
    CONSTRAINT "analysis_jobs_max_attempts_check" CHECK ("maxAttempts" > 0),
    CONSTRAINT "analysis_jobs_estimated_tokens_check" CHECK ("estimatedTokens" IS NULL OR "estimatedTokens" >= 0),
    CONSTRAINT "analysis_jobs_reserved_tokens_check" CHECK ("reservedTokens" IS NULL OR "reservedTokens" >= 0),
    CONSTRAINT "analysis_jobs_prompt_tokens_check" CHECK ("promptTokens" IS NULL OR "promptTokens" >= 0),
    CONSTRAINT "analysis_jobs_completion_tokens_check" CHECK ("completionTokens" IS NULL OR "completionTokens" >= 0),
    CONSTRAINT "analysis_jobs_total_tokens_check" CHECK ("totalTokens" IS NULL OR "totalTokens" >= 0),
    CONSTRAINT "analysis_jobs_request_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "analysis_jobs_error_code_check" CHECK ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z0-9_]{1,64}$'),
    CONSTRAINT "analysis_jobs_error_message_check" CHECK ("lastErrorMessage" IS NULL OR char_length("lastErrorMessage") <= 256),
    CONSTRAINT "analysis_jobs_running_lease_check" CHECK (
        "status" <> 'RUNNING' OR ("leaseToken" IS NOT NULL AND char_length("leaseToken") > 0 AND "leaseExpiresAt" IS NOT NULL)
    ),
    CONSTRAINT "analysis_jobs_succeeded_check" CHECK (
        "status" <> 'SUCCEEDED' OR ("progress" = 100 AND "completedAt" IS NOT NULL AND "tokensSettledAt" IS NOT NULL)
    ),
    CONSTRAINT "analysis_jobs_failed_check" CHECK (
        "status" <> 'FAILED' OR ("completedAt" IS NOT NULL AND "tokensSettledAt" IS NOT NULL AND "lastErrorCode" IS NOT NULL)
    ),
    CONSTRAINT "analysis_jobs_terminal_token_settlement_check" CHECK (
        "status" NOT IN ('SUCCEEDED', 'FAILED') OR
        (
            "promptTokens" IS NOT NULL AND
            "completionTokens" IS NOT NULL AND
            "totalTokens" IS NOT NULL AND
            "totalTokens" = "promptTokens" + "completionTokens"
        ) OR
        (
            "idempotencyKey" LIKE 'legacy-report:%' AND
            "modelVersion" = 'legacy' AND
            "promptVersion" = 'legacy'
        )
    )
);

-- Backfill one completed ledger entry for every existing report. Token usage is
-- intentionally left NULL because historical provider usage cannot be recovered.
INSERT INTO "analysis_jobs" (
    "id",
    "status",
    "stage",
    "progress",
    "userId",
    "repositoryId",
    "idempotencyKey",
    "requestHash",
    "sourceCursor",
    "modelVersion",
    "promptVersion",
    "tokensSettledAt",
    "attemptCount",
    "startedAt",
    "completedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    md5('legacy-analysis-report:' || report."id"::text)::uuid::text,
    'SUCCEEDED'::"AnalysisJobStatus",
    NULL,
    100,
    report."userId",
    report."repositoryId",
    'legacy-report:' || report."id"::text,
    md5('legacy-analysis-report:' || report."id"::text) ||
        md5('legacy-analysis-report-request:' || report."id"::text),
    report."syncTime",
    'legacy',
    'legacy',
    report."syncTime",
    1,
    report."syncTime",
    report."syncTime",
    report."syncTime",
    report."syncTime"
FROM "analysis_reports" AS report;

-- Backfill report-to-job links with the same deterministic identifier.
UPDATE "analysis_reports" AS report
SET "jobId" = md5('legacy-analysis-report:' || report."id"::text)::uuid::text;

-- Backfill the aggregate count from durable reports, not from current score rows.
UPDATE "user_stats" AS stat
SET "analysisCount" = (
    SELECT COUNT(*)::INTEGER
    FROM "analysis_reports" AS report
    WHERE report."userId" = stat."userId"
);

-- CreateIndex
CREATE UNIQUE INDEX "analysis_reports_jobId_key" ON "analysis_reports"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_jobs_userId_idempotencyKey_key" ON "analysis_jobs"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "analysis_jobs_status_nextPublishAt_messagePublishedAt_idx" ON "analysis_jobs"("status", "nextPublishAt", "messagePublishedAt");

-- CreateIndex
CREATE INDEX "analysis_jobs_status_leaseExpiresAt_idx" ON "analysis_jobs"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "analysis_jobs_userId_createdAt_idx" ON "analysis_jobs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "analysis_jobs_repositoryId_createdAt_idx" ON "analysis_jobs"("repositoryId", "createdAt");

-- AddForeignKey
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_reports" ADD CONSTRAINT "analysis_reports_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "analysis_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
