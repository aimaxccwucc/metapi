ALTER TABLE `sites` ADD COLUMN `health_status` VARCHAR(191) NOT NULL DEFAULT 'unknown';
ALTER TABLE `sites` ADD COLUMN `health_reason` TEXT;
ALTER TABLE `sites` ADD COLUMN `health_checked_at` DATETIME;
CREATE INDEX `sites_health_status_idx` ON `sites` (`health_status`);
