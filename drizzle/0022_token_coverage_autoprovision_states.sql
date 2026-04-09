CREATE TABLE IF NOT EXISTS `token_coverage_autoprovision_states` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `site_id` integer NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `model_name` text NOT NULL,
  `target_group` text NOT NULL DEFAULT 'default',
  `status` text NOT NULL DEFAULT 'pending',
  `reason_code` text,
  `message` text,
  `attempt_count` integer NOT NULL DEFAULT 0,
  `last_attempt_at` text,
  `last_success_at` text,
  `cooldown_until` text,
  `last_created_token_name` text,
  `last_created_token_group` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `token_coverage_autoprovision_states_account_model_group_unique`
  ON `token_coverage_autoprovision_states` (`account_id`, `model_name`, `target_group`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `token_coverage_autoprovision_states_status_cooldown_idx`
  ON `token_coverage_autoprovision_states` (`status`, `cooldown_until`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `token_coverage_autoprovision_states_site_account_idx`
  ON `token_coverage_autoprovision_states` (`site_id`, `account_id`);
