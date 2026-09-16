-- AlterEnum
ALTER TYPE "WithdrawalStatus" ADD VALUE 'PARTIAL';

-- CreateEnum
CREATE TYPE "WithdrawalProvider" AS ENUM ('MARKET', 'BOTS');

-- CreateEnum
CREATE TYPE "MarketPurchaseStatus" AS ENUM ('PENDING', 'BOUGHT', 'DELIVERED', 'FAILED');

-- AlterTable
-- Existing requests were all filled out of the bot farm, so they are stamped
-- BOTS rather than left on the new default: the worker decides how to poll a
-- request from this column, and a mislabelled row would be polled by the half
-- of the worker that knows nothing about it.
ALTER TABLE "withdrawals" ADD COLUMN "provider" "WithdrawalProvider" NOT NULL DEFAULT 'BOTS';
ALTER TABLE "withdrawals" ALTER COLUMN "provider" SET DEFAULT 'MARKET';

-- CreateTable
CREATE TABLE "market_purchases" (
    "id" UUID NOT NULL,
    "withdrawalId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "marketHashName" TEXT NOT NULL,
    "status" "MarketPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "maxPrice" INTEGER NOT NULL,
    "paidPrice" INTEGER,
    "stage" INTEGER,
    "marketId" TEXT,
    "tradeOfferId" TEXT,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "boughtAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "market_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_purchases_inventoryItemId_key" ON "market_purchases"("inventoryItemId");

-- CreateIndex
CREATE INDEX "market_purchases_withdrawalId_idx" ON "market_purchases"("withdrawalId");

-- CreateIndex
CREATE INDEX "market_purchases_status_createdAt_idx" ON "market_purchases"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "market_purchases" ADD CONSTRAINT "market_purchases_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_purchases" ADD CONSTRAINT "market_purchases_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_purchases" ADD CONSTRAINT "market_purchases_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
