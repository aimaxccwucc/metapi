ALTER TABLE `token_routes` ADD `probe_policy` text DEFAULT 'system' NOT NULL;
--> statement-breakpoint
UPDATE `token_routes`
SET `probe_policy` = 'manual'
WHERE coalesce(`route_mode`, 'pattern') = 'explicit_group';
