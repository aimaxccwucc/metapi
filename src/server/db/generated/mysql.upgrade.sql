ALTER TABLE `sites` ADD COLUMN `auto_checkin_policy` VARCHAR(191) NOT NULL DEFAULT 'normal';
ALTER TABLE `sites` ADD COLUMN `auto_checkin_reason` TEXT;
ALTER TABLE `sites` ADD COLUMN `auto_checkin_updated_at` VARCHAR(191);
CREATE INDEX `sites_auto_checkin_policy_idx` ON `sites` (`auto_checkin_policy`(191));
