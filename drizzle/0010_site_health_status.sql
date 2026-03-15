ALTER TABLE `sites` ADD COLUMN `health_status` text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE `sites` ADD COLUMN `health_reason` text;
--> statement-breakpoint
ALTER TABLE `sites` ADD COLUMN `health_checked_at` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sites_health_status_idx` ON `sites` (`health_status`);
