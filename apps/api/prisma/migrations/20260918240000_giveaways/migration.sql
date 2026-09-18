-- Skin giveaways. Entry is earned by topping up while one is open and then
-- pressing the button; the draw is provably fair on the same machinery as a
-- case opening, with the seed hash published up front and the seed revealed
-- afterwards so anybody can recompute the winner.

-- CreateEnum
CREATE TYPE "GiveawayStatus" AS ENUM ('SCHEDULED', 'OPEN', 'DRAWN', 'CANCELLED');

-- CreateTable
CREATE TABLE "giveaways" (
    "id" UUID NOT NULL,
    "status" "GiveawayStatus" NOT NULL DEFAULT 'SCHEDULED',
    "itemId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "titleEn" TEXT,
    "minDeposit" INTEGER NOT NULL DEFAULT 0,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "drawsAt" TIMESTAMP(3) NOT NULL,
    "serverSeed" TEXT NOT NULL,
    "serverSeedHash" TEXT NOT NULL,
    "clientSeed" TEXT,
    "roll" INTEGER,
    "winnerUserId" UUID,
    "drawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "giveaways_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "giveaway_entries" (
    "id" UUID NOT NULL,
    "giveawayId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "giveaway_entries_pkey" PRIMARY KEY ("id")
);

-- One entry per player per giveaway, enforced here rather than by a
-- check-then-insert that two clicks could race past.
CREATE UNIQUE INDEX "giveaway_entries_giveawayId_userId_key" ON "giveaway_entries"("giveawayId", "userId");
CREATE INDEX "giveaway_entries_giveawayId_createdAt_idx" ON "giveaway_entries"("giveawayId", "createdAt");
CREATE INDEX "giveaways_status_drawsAt_idx" ON "giveaways"("status", "drawsAt");

-- AddForeignKey
-- Restrict on the prize: a giveaway is the record of what somebody won, and it
-- has to keep being able to say what that was.
ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_winnerUserId_fkey" FOREIGN KEY ("winnerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "giveaways"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
