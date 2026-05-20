ALTER TABLE `proxy_logs` ADD `entry_route_id` integer;
--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD `source_route_id` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proxy_logs_entry_route_id_idx` ON `proxy_logs` (`entry_route_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proxy_logs_source_route_id_idx` ON `proxy_logs` (`source_route_id`);
