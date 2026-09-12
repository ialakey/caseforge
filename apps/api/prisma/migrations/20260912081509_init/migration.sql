-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ANALYST', 'SUPPORT', 'ADMIN');

-- CreateEnum
CREATE TYPE "ItemRarity" AS ENUM ('CONSUMER', 'INDUSTRIAL', 'MILSPEC', 'RESTRICTED', 'CLASSIFIED', 'COVERT', 'EXTRAORDINARY');

-- CreateEnum
CREATE TYPE "InventoryItemStatus" AS ENUM ('AVAILABLE', 'LOCKED', 'WITHDRAWN', 'SOLD');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL_REFUND', 'CASE_OPEN', 'ITEM_SELL', 'ADMIN_ADJUSTMENT', 'BONUS');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('OFFLINE', 'ONLINE', 'BUSY', 'DISABLED', 'ERROR');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "steamId64" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "tradeUrl" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "balance" INTEGER NOT NULL DEFAULT 0,
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "banReason" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "countryCode" CHAR(2),
    "registrationIp" TEXT,
    "lastLoginIp" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" UUID NOT NULL,
    "marketHashName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "rarity" "ItemRarity" NOT NULL,
    "weaponType" TEXT,
    "exterior" TEXT,
    "marketPrice" INTEGER NOT NULL DEFAULT 0,
    "priceOverride" INTEGER,
    "priceUpdatedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cases" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "rtpCached" DOUBLE PRECISION,
    "rtpCalculatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_items" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "rangeFrom" INTEGER NOT NULL,
    "rangeTo" INTEGER NOT NULL,

    CONSTRAINT "case_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_seeds" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seed" TEXT NOT NULL,
    "seedHash" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealedAt" TIMESTAMP(3),

    CONSTRAINT "server_seeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_seeds" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seed" TEXT NOT NULL,
    "isActive" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_seeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_openings" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "serverSeedId" UUID NOT NULL,
    "clientSeedId" UUID NOT NULL,
    "nonce" INTEGER NOT NULL,
    "roll" INTEGER NOT NULL,
    "casePrice" INTEGER NOT NULL,
    "itemPrice" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "status" "InventoryItemStatus" NOT NULL DEFAULT 'AVAILABLE',
    "acquiredPrice" INTEGER NOT NULL,
    "openingId" UUID,
    "withdrawalId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "soldAt" TIMESTAMP(3),

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "referenceId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "totalValue" INTEGER NOT NULL,
    "tradeUrl" TEXT NOT NULL,
    "botId" UUID,
    "tradeOfferId" TEXT,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steam_bots" (
    "id" UUID NOT NULL,
    "steamId64" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "label" TEXT,
    "status" "BotStatus" NOT NULL DEFAULT 'OFFLINE',
    "encryptedPassword" TEXT NOT NULL,
    "encryptedSharedSecret" TEXT NOT NULL,
    "encryptedIdentitySecret" TEXT NOT NULL,
    "maxItems" INTEGER NOT NULL DEFAULT 900,
    "currentItems" INTEGER NOT NULL DEFAULT 0,
    "lastOnlineAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "steam_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_inventory_items" (
    "id" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "assetId" TEXT NOT NULL,
    "isReserved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_steamId64_key" ON "users"("steamId64");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "items_marketHashName_key" ON "items"("marketHashName");

-- CreateIndex
CREATE INDEX "items_rarity_idx" ON "items"("rarity");

-- CreateIndex
CREATE INDEX "items_isActive_idx" ON "items"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "cases_slug_key" ON "cases"("slug");

-- CreateIndex
CREATE INDEX "cases_isActive_sortOrder_idx" ON "cases"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "case_items_caseId_rangeFrom_idx" ON "case_items"("caseId", "rangeFrom");

-- CreateIndex
CREATE UNIQUE INDEX "case_items_caseId_itemId_key" ON "case_items"("caseId", "itemId");

-- CreateIndex
CREATE INDEX "server_seeds_userId_idx" ON "server_seeds"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "server_seeds_one_active_per_user" ON "server_seeds"("userId", "isActive");

-- CreateIndex
CREATE INDEX "client_seeds_userId_idx" ON "client_seeds"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "client_seeds_one_active_per_user" ON "client_seeds"("userId", "isActive");

-- CreateIndex
CREATE INDEX "case_openings_userId_createdAt_idx" ON "case_openings"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "case_openings_caseId_createdAt_idx" ON "case_openings"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "case_openings_createdAt_idx" ON "case_openings"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "case_openings_serverSeedId_nonce_key" ON "case_openings"("serverSeedId", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_openingId_key" ON "inventory_items"("openingId");

-- CreateIndex
CREATE INDEX "inventory_items_userId_status_idx" ON "inventory_items"("userId", "status");

-- CreateIndex
CREATE INDEX "inventory_items_withdrawalId_idx" ON "inventory_items"("withdrawalId");

-- CreateIndex
CREATE INDEX "transactions_userId_createdAt_idx" ON "transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "transactions_type_createdAt_idx" ON "transactions"("type", "createdAt");

-- CreateIndex
CREATE INDEX "transactions_createdAt_idx" ON "transactions"("createdAt");

-- CreateIndex
CREATE INDEX "withdrawals_status_createdAt_idx" ON "withdrawals"("status", "createdAt");

-- CreateIndex
CREATE INDEX "withdrawals_userId_createdAt_idx" ON "withdrawals"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "steam_bots_steamId64_key" ON "steam_bots"("steamId64");

-- CreateIndex
CREATE INDEX "steam_bots_status_idx" ON "steam_bots"("status");

-- CreateIndex
CREATE INDEX "bot_inventory_items_itemId_isReserved_idx" ON "bot_inventory_items"("itemId", "isReserved");

-- CreateIndex
CREATE UNIQUE INDEX "bot_inventory_items_botId_assetId_key" ON "bot_inventory_items"("botId", "assetId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "case_items" ADD CONSTRAINT "case_items_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_items" ADD CONSTRAINT "case_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_seeds" ADD CONSTRAINT "server_seeds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_seeds" ADD CONSTRAINT "client_seeds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_openings" ADD CONSTRAINT "case_openings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_openings" ADD CONSTRAINT "case_openings_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_openings" ADD CONSTRAINT "case_openings_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_openings" ADD CONSTRAINT "case_openings_serverSeedId_fkey" FOREIGN KEY ("serverSeedId") REFERENCES "server_seeds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_openings" ADD CONSTRAINT "case_openings_clientSeedId_fkey" FOREIGN KEY ("clientSeedId") REFERENCES "client_seeds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_openingId_fkey" FOREIGN KEY ("openingId") REFERENCES "case_openings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_botId_fkey" FOREIGN KEY ("botId") REFERENCES "steam_bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_inventory_items" ADD CONSTRAINT "bot_inventory_items_botId_fkey" FOREIGN KEY ("botId") REFERENCES "steam_bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_inventory_items" ADD CONSTRAINT "bot_inventory_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
