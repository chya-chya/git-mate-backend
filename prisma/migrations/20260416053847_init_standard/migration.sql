-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "githubId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "githubToken" TEXT,
    "hashedRefreshToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "availableTokens" INTEGER NOT NULL DEFAULT 100000,
    "representativeReportId" INTEGER,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_stats" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "mutualRespectScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conflictManagementScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "logicalProblemScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewGuidingScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "documentationScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "knowledgeSharingScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "technicalInfluenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "codeStabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" SERIAL NOT NULL,
    "githubRepoId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "isOptedIn" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncTime" TIMESTAMP(3),
    "ownerId" INTEGER NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_reports" (
    "id" SERIAL NOT NULL,
    "syncTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "metrics" JSONB,
    "isShared" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "analysis_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_githubId_key" ON "users"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "users_representativeReportId_key" ON "users"("representativeReportId");

-- CreateIndex
CREATE UNIQUE INDEX "user_stats_userId_key" ON "user_stats"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_githubRepoId_key" ON "repositories"("githubRepoId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_representativeReportId_fkey" FOREIGN KEY ("representativeReportId") REFERENCES "analysis_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_stats" ADD CONSTRAINT "user_stats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_reports" ADD CONSTRAINT "analysis_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_reports" ADD CONSTRAINT "analysis_reports_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
