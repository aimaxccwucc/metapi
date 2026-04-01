CREATE TABLE `routing_governance_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` integer NOT NULL,
	`model_name` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'suppressed' NOT NULL,
	`reason_code` text NOT NULL,
	`reason_detail` text,
	`probe_model_name` text,
	`last_http_status` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`suppress_until` text,
	`probe_after` text,
	`last_failure_at` text,
	`last_success_at` text,
	`last_probe_at` text,
	`last_probe_status` text,
	`last_probe_message` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routing_governance_states_subject_scope_unique` ON `routing_governance_states` (`subject_type`,`subject_id`,`model_name`);
--> statement-breakpoint
CREATE INDEX `routing_governance_states_state_suppress_idx` ON `routing_governance_states` (`state`,`suppress_until`,`probe_after`);
--> statement-breakpoint
CREATE INDEX `routing_governance_states_subject_idx` ON `routing_governance_states` (`subject_type`,`subject_id`);
--> statement-breakpoint
CREATE INDEX `routing_governance_states_reason_state_idx` ON `routing_governance_states` (`reason_code`,`state`);
