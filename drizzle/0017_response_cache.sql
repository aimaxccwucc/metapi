CREATE TABLE `response_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cache_key` text NOT NULL,
	`model` text NOT NULL,
	`response_body` text NOT NULL,
	`is_stream` integer DEFAULT false NOT NULL,
	`prompt_tokens` integer DEFAULT 0,
	`completion_tokens` integer DEFAULT 0,
	`estimated_cost` real DEFAULT 0,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `response_cache_key_idx` ON `response_cache` (`cache_key`);
--> statement-breakpoint
CREATE INDEX `response_cache_expires_at_idx` ON `response_cache` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `response_cache_model_idx` ON `response_cache` (`model`);
