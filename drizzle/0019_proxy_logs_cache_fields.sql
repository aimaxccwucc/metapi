ALTER TABLE `proxy_logs` ADD `cache_status` text;
--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD `cache_saved_cost` real DEFAULT 0;
