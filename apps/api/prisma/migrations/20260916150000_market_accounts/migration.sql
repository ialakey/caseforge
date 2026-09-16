-- CreateEnum
CREATE TYPE "MarketAccountStatus" AS ENUM ('OFFLINE', 'ONLINE', 'DISABLED', 'ERROR');

-- CreateTable
CREATE TABLE "market_accounts" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "status" "MarketAccountStatus" NOT NULL DEFAULT 'OFFLINE',
    "balance" INTEGER,
    "currency" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "checks" JSONB,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_accounts_status_idx" ON "market_accounts"("status");

-- AlterTable
-- Nullable, and it stays nullable: rows written while the site had a single
-- key out of the environment have no account to point at, and inventing one
-- would claim a purchase was made by a key that may not be the one that made
-- it. The poller skips such rows and says so rather than guessing.
ALTER TABLE "market_purchases" ADD COLUMN "accountId" UUID;

-- CreateIndex
CREATE INDEX "market_purchases_accountId_status_idx" ON "market_purchases"("accountId", "status");

-- AddForeignKey
ALTER TABLE "market_purchases" ADD CONSTRAINT "market_purchases_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "market_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
