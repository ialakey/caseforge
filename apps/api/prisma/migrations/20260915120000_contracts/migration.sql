-- AlterEnum
ALTER TYPE "InventoryItemStatus" ADD VALUE 'CONTRACTED';

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "contractRewardId" UUID,
ADD COLUMN     "contractStakeId" UUID;

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stakeCount" INTEGER NOT NULL,
    "stakeValue" INTEGER NOT NULL,
    "targetValue" INTEGER NOT NULL,
    "rewardItemId" UUID NOT NULL,
    "rewardValue" INTEGER NOT NULL,
    "outcomes" JSONB NOT NULL,
    "roll" INTEGER NOT NULL,
    "serverSeedId" UUID NOT NULL,
    "clientSeedId" UUID NOT NULL,
    "nonce" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contracts_userId_createdAt_idx" ON "contracts"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "contracts_createdAt_idx" ON "contracts"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_serverSeedId_nonce_key" ON "contracts"("serverSeedId", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_contractRewardId_key" ON "inventory_items"("contractRewardId");

-- CreateIndex
CREATE INDEX "inventory_items_contractStakeId_idx" ON "inventory_items"("contractStakeId");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_contractStakeId_fkey" FOREIGN KEY ("contractStakeId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_contractRewardId_fkey" FOREIGN KEY ("contractRewardId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_rewardItemId_fkey" FOREIGN KEY ("rewardItemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_serverSeedId_fkey" FOREIGN KEY ("serverSeedId") REFERENCES "server_seeds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_clientSeedId_fkey" FOREIGN KEY ("clientSeedId") REFERENCES "client_seeds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
