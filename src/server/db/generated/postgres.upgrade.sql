ALTER TABLE "sites" ADD COLUMN "health_status" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "sites" ADD COLUMN "health_reason" TEXT;
ALTER TABLE "sites" ADD COLUMN "health_checked_at" TIMESTAMP;
CREATE INDEX "sites_health_status_idx" ON "sites" ("health_status");
