CREATE TABLE IF NOT EXISTS `checkin_states` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL REFERENCES `accounts`(`id`) ON DELETE cascade,
  `site_id` integer NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `status` text NOT NULL DEFAULT 'unknown',
  `reason_code` text,
  `message` text,
  `retryable` integer NOT NULL DEFAULT 0,
  `requires_manual` integer NOT NULL DEFAULT 0,
  `unsupported` integer NOT NULL DEFAULT 0,
  `consecutive_failures` integer NOT NULL DEFAULT 0,
  `last_attempt_at` text,
  `last_success_at` text,
  `next_retry_at` text,
  `last_relogin_status` text,
  `schedule_mode` text,
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `checkin_states_account_unique` ON `checkin_states` (`account_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `checkin_states_site_status_idx` ON `checkin_states` (`site_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `checkin_states_status_retry_idx` ON `checkin_states` (`status`, `next_retry_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `checkin_states_manual_idx` ON `checkin_states` (`requires_manual`, `updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `site_profiles` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `site_id` integer NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `platform` text NOT NULL DEFAULT 'unknown',
  `credential_mode` text NOT NULL DEFAULT 'mixed',
  `supports_admin_api` integer NOT NULL DEFAULT 0,
  `supports_checkin` integer NOT NULL DEFAULT 0,
  `waf_profile` text NOT NULL DEFAULT 'unknown',
  `model_discovery_source` text NOT NULL DEFAULT 'account_models',
  `onboarding_score` integer NOT NULL DEFAULT 0,
  `operational_score` integer NOT NULL DEFAULT 0,
  `last_detected_at` text,
  `profile_json` text,
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_profiles_site_unique` ON `site_profiles` (`site_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_profiles_operational_score_idx` ON `site_profiles` (`operational_score`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_profiles_platform_idx` ON `site_profiles` (`platform`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `site_protocol_profiles` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `site_id` integer NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
  `preferred_endpoint` text,
  `verified_endpoints` text,
  `fallback_endpoints` text,
  `probe_model_name` text,
  `last_success_at` text,
  `last_failure_code` text,
  `cooldown_until` text,
  `source` text NOT NULL DEFAULT 'derived',
  `profile_version` integer NOT NULL DEFAULT 1,
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_protocol_profiles_site_unique` ON `site_protocol_profiles` (`site_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_protocol_profiles_preferred_idx` ON `site_protocol_profiles` (`preferred_endpoint`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_protocol_profiles_cooldown_idx` ON `site_protocol_profiles` (`cooldown_until`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `model_capability_profiles` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `model_name` text NOT NULL,
  `endpoint_types` text,
  `supports_tools` integer NOT NULL DEFAULT 0,
  `supports_vision` integer NOT NULL DEFAULT 0,
  `supports_files` integer NOT NULL DEFAULT 0,
  `supports_reasoning` integer NOT NULL DEFAULT 0,
  `supports_streaming` integer NOT NULL DEFAULT 1,
  `source` text NOT NULL DEFAULT 'heuristic',
  `confidence` text NOT NULL DEFAULT 'medium',
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `model_capability_profiles_model_unique` ON `model_capability_profiles` (`model_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `model_capability_profiles_tools_idx` ON `model_capability_profiles` (`supports_tools`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `model_capability_profiles_vision_idx` ON `model_capability_profiles` (`supports_vision`);
