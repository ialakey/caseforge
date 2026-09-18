-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "anonId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" UUID,
    "path" TEXT,
    "referrer" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "device" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_daily" (
    "day" DATE NOT NULL,
    "key" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metrics_daily_pkey" PRIMARY KEY ("day","key")
);

-- CreateIndex
CREATE INDEX "analytics_events_createdAt_idx" ON "analytics_events"("createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_type_createdAt_idx" ON "analytics_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_anonId_createdAt_idx" ON "analytics_events"("anonId", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_userId_createdAt_idx" ON "analytics_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_utmSource_createdAt_idx" ON "analytics_events"("utmSource", "createdAt");

-- CreateIndex
CREATE INDEX "metrics_daily_key_day_idx" ON "metrics_daily"("key", "day");

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

