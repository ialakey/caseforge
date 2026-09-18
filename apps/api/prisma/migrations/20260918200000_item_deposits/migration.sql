-- Depositing skins: the mirror of a withdrawal, run in the other direction.
-- The valuation is frozen on the request, so a market move while the offer
-- sits in Steam cannot change what the player was promised.

-- CreateEnum
CREATE TYPE "ItemDepositStatus" AS ENUM ('PENDING', 'OFFER_SENT', 'ACCEPTED', 'CREDITED', 'DECLINED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "item_deposits" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "ItemDepositStatus" NOT NULL DEFAULT 'PENDING',
    "totalValue" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "tradeUrl" TEXT NOT NULL,
    "botId" UUID,
    "tradeOfferId" TEXT,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "item_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_deposit_items" (
    "id" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "assetId" TEXT NOT NULL,
    "marketHashName" TEXT NOT NULL,
    "itemId" UUID,
    "marketPrice" INTEGER NOT NULL,
    "payout" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_deposit_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "item_deposits_status_createdAt_idx" ON "item_deposits"("status", "createdAt");
CREATE INDEX "item_deposits_userId_createdAt_idx" ON "item_deposits"("userId", "createdAt");
CREATE INDEX "item_deposit_items_depositId_idx" ON "item_deposit_items"("depositId");

-- AddForeignKey
ALTER TABLE "item_deposits" ADD CONSTRAINT "item_deposits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_deposits" ADD CONSTRAINT "item_deposits_botId_fkey" FOREIGN KEY ("botId") REFERENCES "steam_bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "item_deposit_items" ADD CONSTRAINT "item_deposit_items_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "item_deposits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "item_deposit_items" ADD CONSTRAINT "item_deposit_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Balance credited for skins is its own kind of money movement: the item
-- channel has a different margin from a card top-up, and a report that mixed
-- them could describe neither.
ALTER TYPE "TransactionType" ADD VALUE 'ITEM_DEPOSIT';
