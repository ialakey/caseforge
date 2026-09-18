-- A free case is rationed by a deposit requirement and a cooldown instead of
-- a price. Defaults make every existing case an ordinary paid one, so the
-- columns can land before anything is configured to use them.

-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "isFree" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "freeMinDeposit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "freeMaxOpens" INTEGER NOT NULL DEFAULT 1;

-- The gate counts a player's top-ups and their openings of one case over the
-- last 24 hours, on every visit to a free case page. Both are a scan by user
-- and time that the existing indexes do not serve.
CREATE INDEX "transactions_userId_type_createdAt_idx"
  ON "transactions"("userId", "type", "createdAt");
CREATE INDEX "case_openings_userId_caseId_createdAt_idx"
  ON "case_openings"("userId", "caseId", "createdAt");
