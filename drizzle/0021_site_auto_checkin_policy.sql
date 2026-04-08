ALTER TABLE `sites` ADD COLUMN `auto_checkin_policy` text NOT NULL DEFAULT 'normal';
--> statement-breakpoint
ALTER TABLE `sites` ADD COLUMN `auto_checkin_reason` text;
--> statement-breakpoint
ALTER TABLE `sites` ADD COLUMN `auto_checkin_updated_at` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sites_auto_checkin_policy_idx` ON `sites` (`auto_checkin_policy`);
