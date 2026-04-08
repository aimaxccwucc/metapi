ALTER TABLE "sites" ADD COLUMN "auto_checkin_policy" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "sites" ADD COLUMN "auto_checkin_reason" TEXT;
ALTER TABLE "sites" ADD COLUMN "auto_checkin_updated_at" TEXT;
CREATE INDEX "sites_auto_checkin_policy_idx" ON "sites" ("auto_checkin_policy");
