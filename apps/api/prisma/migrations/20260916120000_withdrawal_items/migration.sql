-- CreateTable
CREATE TABLE "withdrawal_items" (
    "id" UUID NOT NULL,
    "withdrawalId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "marketHashName" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_items_withdrawalId_inventoryItemId_key" ON "withdrawal_items"("withdrawalId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "withdrawal_items_withdrawalId_idx" ON "withdrawal_items"("withdrawalId");

-- AddForeignKey
ALTER TABLE "withdrawal_items" ADD CONSTRAINT "withdrawal_items_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_items" ADD CONSTRAINT "withdrawal_items_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_items" ADD CONSTRAINT "withdrawal_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill.
--
-- Only requests still holding their items can be recovered, because the link
-- this table replaces is precisely the one that gets cleared on a refund. A
-- request that already failed and gave everything back has nothing left to
-- reconstruct from and stays empty — which is the bug being fixed, not a new
-- one, and it applies only to requests made before this migration.
INSERT INTO "withdrawal_items" ("id", "withdrawalId", "inventoryItemId", "itemId", "marketHashName", "price", "createdAt")
SELECT gen_random_uuid(), inv."withdrawalId", inv."id", inv."itemId", it."marketHashName", inv."acquiredPrice", inv."createdAt"
FROM "inventory_items" inv
JOIN "items" it ON it."id" = inv."itemId"
WHERE inv."withdrawalId" IS NOT NULL;
