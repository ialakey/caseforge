-- CreateEnum
CREATE TYPE "BonusKind" AS ENUM ('BALANCE', 'DISCOUNT', 'FREE_CASE', 'FREE_ITEM');

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "bonusRewardId" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastBonusAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "daily_bonuses" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "BonusKind" NOT NULL,
    "segmentKey" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "itemId" UUID,
    "itemPrice" INTEGER,
    "serverSeedId" UUID NOT NULL,
    "clientSeedId" UUID NOT NULL,
    "nonce" INTEGER NOT NULL,
    "roll" INTEGER NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_bonuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_bonuses_userId_createdAt_idx" ON "daily_bonuses"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "daily_bonuses_userId_consumedAt_idx" ON "daily_bonuses"("userId", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "daily_bonuses_serverSeedId_nonce_key" ON "daily_bonuses"("serverSeedId", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_bonusRewardId_key" ON "inventory_items"("bonusRewardId");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_bonusRewardId_fkey" FOREIGN KEY ("bonusRewardId") REFERENCES "daily_bonuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_bonuses" ADD CONSTRAINT "daily_bonuses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_bonuses" ADD CONSTRAINT "daily_bonuses_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_bonuses" ADD CONSTRAINT "daily_bonuses_serverSeedId_fkey" FOREIGN KEY ("serverSeedId") REFERENCES "server_seeds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_bonuses" ADD CONSTRAINT "daily_bonuses_clientSeedId_fkey" FOREIGN KEY ("clientSeedId") REFERENCES "client_seeds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

