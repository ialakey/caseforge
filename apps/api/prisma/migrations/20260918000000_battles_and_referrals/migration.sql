-- CreateEnum
CREATE TYPE "BattleStatus" AS ENUM ('WAITING', 'RUNNING', 'FINISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BattleMode" AS ENUM ('STANDARD', 'CRAZY');

-- CreateEnum
CREATE TYPE "ReferralEarningKind" AS ENUM ('DEPOSIT', 'WAGER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'BATTLE_ENTRY';
ALTER TYPE "TransactionType" ADD VALUE 'BATTLE_REFUND';
ALTER TYPE "TransactionType" ADD VALUE 'REFERRAL';

-- AlterTable
ALTER TABLE "case_openings" ADD COLUMN     "battleId" UUID,
ADD COLUMN     "battleRound" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "referralCode" TEXT;

-- CreateTable
CREATE TABLE "battles" (
    "id" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "status" "BattleStatus" NOT NULL DEFAULT 'WAITING',
    "mode" "BattleMode" NOT NULL DEFAULT 'STANDARD',
    "slots" INTEGER NOT NULL,
    "filledSlots" INTEGER NOT NULL DEFAULT 0,
    "rounds" INTEGER NOT NULL,
    "entryPrice" INTEGER NOT NULL,
    "totalValue" INTEGER,
    "winnerId" UUID,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "battles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battle_cases" (
    "id" UUID NOT NULL,
    "battleId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,

    CONSTRAINT "battle_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battle_players" (
    "id" UUID NOT NULL,
    "battleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "totalValue" INTEGER NOT NULL DEFAULT 0,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "battle_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "referrerId" UUID NOT NULL,
    "refereeId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "sameIp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_earnings" (
    "id" UUID NOT NULL,
    "referrerId" UUID NOT NULL,
    "refereeId" UUID NOT NULL,
    "kind" "ReferralEarningKind" NOT NULL,
    "sourceAmount" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "referenceId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "battles_status_createdAt_idx" ON "battles"("status", "createdAt");

-- CreateIndex
CREATE INDEX "battles_hostId_createdAt_idx" ON "battles"("hostId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "battle_cases_battleId_position_key" ON "battle_cases"("battleId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "battle_cases_battleId_caseId_key" ON "battle_cases"("battleId", "caseId");

-- CreateIndex
CREATE INDEX "battle_players_userId_joinedAt_idx" ON "battle_players"("userId", "joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "battle_players_battleId_userId_key" ON "battle_players"("battleId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "battle_players_battleId_slot_key" ON "battle_players"("battleId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_refereeId_key" ON "referrals"("refereeId");

-- CreateIndex
CREATE INDEX "referrals_referrerId_createdAt_idx" ON "referrals"("referrerId", "createdAt");

-- CreateIndex
CREATE INDEX "referral_earnings_referrerId_claimedAt_idx" ON "referral_earnings"("referrerId", "claimedAt");

-- CreateIndex
CREATE INDEX "referral_earnings_referrerId_createdAt_idx" ON "referral_earnings"("referrerId", "createdAt");

-- CreateIndex
CREATE INDEX "referral_earnings_refereeId_createdAt_idx" ON "referral_earnings"("refereeId", "createdAt");

-- CreateIndex
CREATE INDEX "case_openings_battleId_battleRound_idx" ON "case_openings"("battleId", "battleRound");

-- CreateIndex
CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode");

-- AddForeignKey
ALTER TABLE "case_openings" ADD CONSTRAINT "case_openings_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "battles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battles" ADD CONSTRAINT "battles_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battles" ADD CONSTRAINT "battles_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battle_cases" ADD CONSTRAINT "battle_cases_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "battles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battle_cases" ADD CONSTRAINT "battle_cases_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battle_players" ADD CONSTRAINT "battle_players_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "battles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "battle_players" ADD CONSTRAINT "battle_players_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_earnings" ADD CONSTRAINT "referral_earnings_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_earnings" ADD CONSTRAINT "referral_earnings_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

