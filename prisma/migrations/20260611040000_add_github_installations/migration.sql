-- CreateEnum
CREATE TYPE "GithubInstallationAccountType" AS ENUM ('USER', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "GithubInstallationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "GithubInstallationLinkSource" AS ENUM ('INSTALL_CALLBACK', 'AUTO_DISCOVERY');

-- CreateTable
CREATE TABLE "github_installations" (
    "id" SERIAL NOT NULL,
    "githubInstallationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" "GithubInstallationAccountType" NOT NULL,
    "repositorySelection" TEXT NOT NULL,
    "status" "GithubInstallationStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspendedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "githubCreatedAt" TIMESTAMP(3),
    "githubUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_github_installations" (
    "userId" INTEGER NOT NULL,
    "installationId" INTEGER NOT NULL,
    "source" "GithubInstallationLinkSource" NOT NULL,
    "membershipVerifiedAt" TIMESTAMP(3) NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_github_installations_pkey" PRIMARY KEY ("userId","installationId")
);

-- CreateTable
CREATE TABLE "github_app_install_states" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_app_install_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_githubInstallationId_key" ON "github_installations"("githubInstallationId");

-- CreateIndex
CREATE INDEX "github_installations_accountType_accountLogin_idx" ON "github_installations"("accountType", "accountLogin");

-- CreateIndex
CREATE INDEX "user_github_installations_installationId_idx" ON "user_github_installations"("installationId");

-- CreateIndex
CREATE INDEX "github_app_install_states_userId_idx" ON "github_app_install_states"("userId");

-- CreateIndex
CREATE INDEX "github_app_install_states_expiresAt_idx" ON "github_app_install_states"("expiresAt");

-- AddForeignKey
ALTER TABLE "user_github_installations" ADD CONSTRAINT "user_github_installations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_github_installations" ADD CONSTRAINT "user_github_installations_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "github_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_app_install_states" ADD CONSTRAINT "github_app_install_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
