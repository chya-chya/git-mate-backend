ALTER TABLE "analysis_jobs"
ADD COLUMN "collectionCutoff" TIMESTAMP(3);

UPDATE "analysis_jobs"
SET "collectionCutoff" = "createdAt";

ALTER TABLE "analysis_jobs"
ALTER COLUMN "collectionCutoff" SET NOT NULL,
ALTER COLUMN "collectionCutoff" SET DEFAULT CURRENT_TIMESTAMP;
