-- CreateEnum
CREATE TYPE "UpgradeStatus" AS ENUM ('WON', 'LOST');

-- AlterEnum
ALTER TYPE "InventoryItemStatus" ADD VALUE 'UPGRADED';

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "upgradeRewardId" UUID,
ADD COLUMN     "upgradeStakeId" UUID;

-- CreateTable
CREATE TABLE "upgrades" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "UpgradeStatus" NOT NULL,
    "targetItemId" UUID NOT NULL,
    "stakeValue" INTEGER NOT NULL,
    "targetValue" INTEGER NOT NULL,
    "chance" DOUBLE PRECISION NOT NULL,
    "winThreshold" INTEGER NOT NULL,
    "roll" INTEGER NOT NULL,
    "serverSeedId" UUID NOT NULL,
    "clientSeedId" UUID NOT NULL,
    "nonce" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upgrades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upgrades_userId_createdAt_idx" ON "upgrades"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "upgrades_createdAt_idx" ON "upgrades"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "upgrades_serverSeedId_nonce_key" ON "upgrades"("serverSeedId", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_upgradeStakeId_key" ON "inventory_items"("upgradeStakeId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_upgradeRewardId_key" ON "inventory_items"("upgradeRewardId");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_upgradeStakeId_fkey" FOREIGN KEY ("upgradeStakeId") REFERENCES "upgrades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_upgradeRewardId_fkey" FOREIGN KEY ("upgradeRewardId") REFERENCES "upgrades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upgrades" ADD CONSTRAINT "upgrades_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upgrades" ADD CONSTRAINT "upgrades_targetItemId_fkey" FOREIGN KEY ("targetItemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upgrades" ADD CONSTRAINT "upgrades_serverSeedId_fkey" FOREIGN KEY ("serverSeedId") REFERENCES "server_seeds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upgrades" ADD CONSTRAINT "upgrades_clientSeedId_fkey" FOREIGN KEY ("clientSeedId") REFERENCES "client_seeds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

