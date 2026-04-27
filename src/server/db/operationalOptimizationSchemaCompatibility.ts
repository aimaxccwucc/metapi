export type OperationalOptimizationSchemaDialect = 'sqlite' | 'mysql' | 'postgres';

export interface OperationalOptimizationSchemaInspector {
  dialect: OperationalOptimizationSchemaDialect;
  tableExists(table: string): Promise<boolean>;
  columnExists(table: string, column: string): Promise<boolean>;
  execute(sqlText: string): Promise<void>;
}

function isIgnorableExistingObjectError(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
  const message = error instanceof Error ? error.message : String(error || '');
  const lowered = message.toLowerCase();
  return code === 'ER_DUP_KEYNAME'
    || code === 'ER_TABLE_EXISTS_ERROR'
    || lowered.includes('duplicate key name')
    || lowered.includes('already exists')
    || (lowered.includes('relation') && lowered.includes('already exists'));
}

const CREATE_TABLE_SQL: Record<OperationalOptimizationSchemaDialect, Record<string, string>> = {
  sqlite: {
    checkin_states: `CREATE TABLE IF NOT EXISTS checkin_states (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, account_id integer NOT NULL REFERENCES accounts(id) ON DELETE cascade, site_id integer NOT NULL REFERENCES sites(id) ON DELETE cascade, status text NOT NULL DEFAULT 'unknown', reason_code text, message text, retryable integer NOT NULL DEFAULT 0, requires_manual integer NOT NULL DEFAULT 0, unsupported integer NOT NULL DEFAULT 0, consecutive_failures integer NOT NULL DEFAULT 0, last_attempt_at text, last_success_at text, next_retry_at text, last_relogin_status text, schedule_mode text, updated_at text NOT NULL DEFAULT (datetime('now')), created_at text NOT NULL DEFAULT (datetime('now')));`,
    site_profiles: `CREATE TABLE IF NOT EXISTS site_profiles (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, site_id integer NOT NULL REFERENCES sites(id) ON DELETE cascade, platform text NOT NULL DEFAULT 'unknown', credential_mode text NOT NULL DEFAULT 'mixed', supports_admin_api integer NOT NULL DEFAULT 0, supports_checkin integer NOT NULL DEFAULT 0, waf_profile text NOT NULL DEFAULT 'unknown', model_discovery_source text NOT NULL DEFAULT 'account_models', onboarding_score integer NOT NULL DEFAULT 0, operational_score integer NOT NULL DEFAULT 0, last_detected_at text, profile_json text, updated_at text NOT NULL DEFAULT (datetime('now')), created_at text NOT NULL DEFAULT (datetime('now')));`,
    site_protocol_profiles: `CREATE TABLE IF NOT EXISTS site_protocol_profiles (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, site_id integer NOT NULL REFERENCES sites(id) ON DELETE cascade, preferred_endpoint text, verified_endpoints text, fallback_endpoints text, probe_model_name text, last_success_at text, last_failure_code text, cooldown_until text, source text NOT NULL DEFAULT 'derived', profile_version integer NOT NULL DEFAULT 1, updated_at text NOT NULL DEFAULT (datetime('now')), created_at text NOT NULL DEFAULT (datetime('now')));`,
    model_capability_profiles: `CREATE TABLE IF NOT EXISTS model_capability_profiles (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, model_name text NOT NULL, endpoint_types text, supports_tools integer NOT NULL DEFAULT 0, supports_vision integer NOT NULL DEFAULT 0, supports_files integer NOT NULL DEFAULT 0, supports_reasoning integer NOT NULL DEFAULT 0, supports_streaming integer NOT NULL DEFAULT 1, source text NOT NULL DEFAULT 'heuristic', confidence text NOT NULL DEFAULT 'medium', updated_at text NOT NULL DEFAULT (datetime('now')), created_at text NOT NULL DEFAULT (datetime('now')));`,
  },
  mysql: {
    checkin_states: 'CREATE TABLE IF NOT EXISTS `checkin_states` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `account_id` INT NOT NULL, `site_id` INT NOT NULL, `status` VARCHAR(191) NOT NULL DEFAULT \'unknown\', `reason_code` TEXT, `message` TEXT, `retryable` BOOLEAN NOT NULL DEFAULT false, `requires_manual` BOOLEAN NOT NULL DEFAULT false, `unsupported` BOOLEAN NOT NULL DEFAULT false, `consecutive_failures` INT NOT NULL DEFAULT 0, `last_attempt_at` VARCHAR(191), `last_success_at` VARCHAR(191), `next_retry_at` VARCHAR(191), `last_relogin_status` TEXT, `schedule_mode` VARCHAR(191), `updated_at` VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), \'%Y-%m-%d %H:%i:%s\')), `created_at` VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), \'%Y-%m-%d %H:%i:%s\')), CONSTRAINT `checkin_states_account_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE, CONSTRAINT `checkin_states_site_fk` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE)',
    site_profiles: 'CREATE TABLE IF NOT EXISTS `site_profiles` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `site_id` INT NOT NULL, `platform` VARCHAR(191) NOT NULL DEFAULT \'unknown\', `credential_mode` VARCHAR(191) NOT NULL DEFAULT \'mixed\', `supports_admin_api` BOOLEAN NOT NULL DEFAULT false, `supports_checkin` BOOLEAN NOT NULL DEFAULT false, `waf_profile` VARCHAR(191) NOT NULL DEFAULT \'unknown\', `model_discovery_source` VARCHAR(191) NOT NULL DEFAULT \'account_models\', `onboarding_score` INT NOT NULL DEFAULT 0, `operational_score` INT NOT NULL DEFAULT 0, `last_detected_at` VARCHAR(191), `profile_json` JSON, `updated_at` VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), \'%Y-%m-%d %H:%i:%s\')), `created_at` VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), \'%Y-%m-%d %H:%i:%s\')), CONSTRAINT `site_profiles_site_fk` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE)',
    site_protocol_profiles: 'CREATE TABLE IF NOT EXISTS `site_protocol_profiles` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `site_id` INT NOT NULL, `preferred_endpoint` VARCHAR(191), `verified_endpoints` JSON, `fallback_endpoints` JSON, `probe_model_name` TEXT, `last_success_at` VARCHAR(191), `last_failure_code` TEXT, `cooldown_until` VARCHAR(191), `source` VARCHAR(191) NOT NULL DEFAULT \'derived\', `profile_version` INT NOT NULL DEFAULT 1, `updated_at` VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), \'%Y-%m-%d %H:%i:%s\')), `created_at` VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), \'%Y-%m-%d %H:%i:%s\')), CONSTRAINT `site_protocol_profiles_site_fk` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE)',
    model_capability_profiles: 'CREATE TABLE IF NOT EXISTS `model_capability_profiles` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `model_name` VARCHAR(191) NOT NULL, `endpoint_types` JSON, `supports_tools` BOOLEAN NOT NULL DEFAULT false, `supports_vision` BOOLEAN NOT NULL DEFAULT false, `supports_files` BOOLEAN NOT NULL DEFAULT false, `supports_reasoning` BOOLEAN NOT NULL DEFAULT false, `supports_streaming` BOOLEAN NOT NULL DEFAULT true, `source` VARCHAR(191) NOT NULL DEFAULT \'heuristic\', `confidence` VARCHAR(191) NOT NULL DEFAULT \'medium\', `updated_at` VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), \'%Y-%m-%d %H:%i:%s\')), `created_at` VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), \'%Y-%m-%d %H:%i:%s\')))',
  },
  postgres: {
    checkin_states: 'CREATE TABLE IF NOT EXISTS "checkin_states" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "site_id" INTEGER NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE, "status" TEXT NOT NULL DEFAULT \'unknown\', "reason_code" TEXT, "message" TEXT, "retryable" BOOLEAN NOT NULL DEFAULT false, "requires_manual" BOOLEAN NOT NULL DEFAULT false, "unsupported" BOOLEAN NOT NULL DEFAULT false, "consecutive_failures" INTEGER NOT NULL DEFAULT 0, "last_attempt_at" TEXT, "last_success_at" TEXT, "next_retry_at" TEXT, "last_relogin_status" TEXT, "schedule_mode" TEXT, "updated_at" TEXT NOT NULL DEFAULT to_char(timezone(\'UTC\', CURRENT_TIMESTAMP), \'YYYY-MM-DD HH24:MI:SS\'), "created_at" TEXT NOT NULL DEFAULT to_char(timezone(\'UTC\', CURRENT_TIMESTAMP), \'YYYY-MM-DD HH24:MI:SS\'))',
    site_profiles: 'CREATE TABLE IF NOT EXISTS "site_profiles" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "site_id" INTEGER NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE, "platform" TEXT NOT NULL DEFAULT \'unknown\', "credential_mode" TEXT NOT NULL DEFAULT \'mixed\', "supports_admin_api" BOOLEAN NOT NULL DEFAULT false, "supports_checkin" BOOLEAN NOT NULL DEFAULT false, "waf_profile" TEXT NOT NULL DEFAULT \'unknown\', "model_discovery_source" TEXT NOT NULL DEFAULT \'account_models\', "onboarding_score" INTEGER NOT NULL DEFAULT 0, "operational_score" INTEGER NOT NULL DEFAULT 0, "last_detected_at" TEXT, "profile_json" JSONB, "updated_at" TEXT NOT NULL DEFAULT to_char(timezone(\'UTC\', CURRENT_TIMESTAMP), \'YYYY-MM-DD HH24:MI:SS\'), "created_at" TEXT NOT NULL DEFAULT to_char(timezone(\'UTC\', CURRENT_TIMESTAMP), \'YYYY-MM-DD HH24:MI:SS\'))',
    site_protocol_profiles: 'CREATE TABLE IF NOT EXISTS "site_protocol_profiles" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "site_id" INTEGER NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE, "preferred_endpoint" TEXT, "verified_endpoints" JSONB, "fallback_endpoints" JSONB, "probe_model_name" TEXT, "last_success_at" TEXT, "last_failure_code" TEXT, "cooldown_until" TEXT, "source" TEXT NOT NULL DEFAULT \'derived\', "profile_version" INTEGER NOT NULL DEFAULT 1, "updated_at" TEXT NOT NULL DEFAULT to_char(timezone(\'UTC\', CURRENT_TIMESTAMP), \'YYYY-MM-DD HH24:MI:SS\'), "created_at" TEXT NOT NULL DEFAULT to_char(timezone(\'UTC\', CURRENT_TIMESTAMP), \'YYYY-MM-DD HH24:MI:SS\'))',
    model_capability_profiles: 'CREATE TABLE IF NOT EXISTS "model_capability_profiles" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "model_name" TEXT NOT NULL, "endpoint_types" JSONB, "supports_tools" BOOLEAN NOT NULL DEFAULT false, "supports_vision" BOOLEAN NOT NULL DEFAULT false, "supports_files" BOOLEAN NOT NULL DEFAULT false, "supports_reasoning" BOOLEAN NOT NULL DEFAULT false, "supports_streaming" BOOLEAN NOT NULL DEFAULT true, "source" TEXT NOT NULL DEFAULT \'heuristic\', "confidence" TEXT NOT NULL DEFAULT \'medium\', "updated_at" TEXT NOT NULL DEFAULT to_char(timezone(\'UTC\', CURRENT_TIMESTAMP), \'YYYY-MM-DD HH24:MI:SS\'), "created_at" TEXT NOT NULL DEFAULT to_char(timezone(\'UTC\', CURRENT_TIMESTAMP), \'YYYY-MM-DD HH24:MI:SS\'))',
  },
};

const CREATE_INDEX_SQL: Record<OperationalOptimizationSchemaDialect, string[]> = {
  sqlite: [
    'CREATE UNIQUE INDEX IF NOT EXISTS checkin_states_account_unique ON checkin_states(account_id);',
    'CREATE INDEX IF NOT EXISTS checkin_states_site_status_idx ON checkin_states(site_id, status);',
    'CREATE INDEX IF NOT EXISTS checkin_states_status_retry_idx ON checkin_states(status, next_retry_at);',
    'CREATE INDEX IF NOT EXISTS checkin_states_manual_idx ON checkin_states(requires_manual, updated_at);',
    'CREATE UNIQUE INDEX IF NOT EXISTS site_profiles_site_unique ON site_profiles(site_id);',
    'CREATE INDEX IF NOT EXISTS site_profiles_operational_score_idx ON site_profiles(operational_score);',
    'CREATE INDEX IF NOT EXISTS site_profiles_platform_idx ON site_profiles(platform);',
    'CREATE UNIQUE INDEX IF NOT EXISTS site_protocol_profiles_site_unique ON site_protocol_profiles(site_id);',
    'CREATE INDEX IF NOT EXISTS site_protocol_profiles_preferred_idx ON site_protocol_profiles(preferred_endpoint);',
    'CREATE INDEX IF NOT EXISTS site_protocol_profiles_cooldown_idx ON site_protocol_profiles(cooldown_until);',
    'CREATE UNIQUE INDEX IF NOT EXISTS model_capability_profiles_model_unique ON model_capability_profiles(model_name);',
    'CREATE INDEX IF NOT EXISTS model_capability_profiles_tools_idx ON model_capability_profiles(supports_tools);',
    'CREATE INDEX IF NOT EXISTS model_capability_profiles_vision_idx ON model_capability_profiles(supports_vision);',
  ],
  mysql: [
    'CREATE UNIQUE INDEX `checkin_states_account_unique` ON `checkin_states` (`account_id`)',
    'CREATE INDEX `checkin_states_site_status_idx` ON `checkin_states` (`site_id`, `status`)',
    'CREATE INDEX `checkin_states_status_retry_idx` ON `checkin_states` (`status`, `next_retry_at`)',
    'CREATE INDEX `checkin_states_manual_idx` ON `checkin_states` (`requires_manual`, `updated_at`)',
    'CREATE UNIQUE INDEX `site_profiles_site_unique` ON `site_profiles` (`site_id`)',
    'CREATE INDEX `site_profiles_operational_score_idx` ON `site_profiles` (`operational_score`)',
    'CREATE INDEX `site_profiles_platform_idx` ON `site_profiles` (`platform`)',
    'CREATE UNIQUE INDEX `site_protocol_profiles_site_unique` ON `site_protocol_profiles` (`site_id`)',
    'CREATE INDEX `site_protocol_profiles_preferred_idx` ON `site_protocol_profiles` (`preferred_endpoint`)',
    'CREATE INDEX `site_protocol_profiles_cooldown_idx` ON `site_protocol_profiles` (`cooldown_until`)',
    'CREATE UNIQUE INDEX `model_capability_profiles_model_unique` ON `model_capability_profiles` (`model_name`)',
    'CREATE INDEX `model_capability_profiles_tools_idx` ON `model_capability_profiles` (`supports_tools`)',
    'CREATE INDEX `model_capability_profiles_vision_idx` ON `model_capability_profiles` (`supports_vision`)',
  ],
  postgres: [
    'CREATE UNIQUE INDEX IF NOT EXISTS "checkin_states_account_unique" ON "checkin_states" ("account_id")',
    'CREATE INDEX IF NOT EXISTS "checkin_states_site_status_idx" ON "checkin_states" ("site_id", "status")',
    'CREATE INDEX IF NOT EXISTS "checkin_states_status_retry_idx" ON "checkin_states" ("status", "next_retry_at")',
    'CREATE INDEX IF NOT EXISTS "checkin_states_manual_idx" ON "checkin_states" ("requires_manual", "updated_at")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "site_profiles_site_unique" ON "site_profiles" ("site_id")',
    'CREATE INDEX IF NOT EXISTS "site_profiles_operational_score_idx" ON "site_profiles" ("operational_score")',
    'CREATE INDEX IF NOT EXISTS "site_profiles_platform_idx" ON "site_profiles" ("platform")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "site_protocol_profiles_site_unique" ON "site_protocol_profiles" ("site_id")',
    'CREATE INDEX IF NOT EXISTS "site_protocol_profiles_preferred_idx" ON "site_protocol_profiles" ("preferred_endpoint")',
    'CREATE INDEX IF NOT EXISTS "site_protocol_profiles_cooldown_idx" ON "site_protocol_profiles" ("cooldown_until")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "model_capability_profiles_model_unique" ON "model_capability_profiles" ("model_name")',
    'CREATE INDEX IF NOT EXISTS "model_capability_profiles_tools_idx" ON "model_capability_profiles" ("supports_tools")',
    'CREATE INDEX IF NOT EXISTS "model_capability_profiles_vision_idx" ON "model_capability_profiles" ("supports_vision")',
  ],
};

export function ensureOperationalOptimizationSqliteSchemaSync(input: {
  tableExists(table: string): boolean;
  execute(sqlText: string): void;
}): void {
  for (const [tableName, sqlText] of Object.entries(CREATE_TABLE_SQL.sqlite)) {
    if (input.tableExists(tableName)) continue;
    input.execute(sqlText);
  }
  for (const sqlText of CREATE_INDEX_SQL.sqlite) {
    input.execute(sqlText);
  }
}

export async function ensureOperationalOptimizationSchemaCompatibility(
  inspector: OperationalOptimizationSchemaInspector,
): Promise<void> {
  for (const [tableName, sqlText] of Object.entries(CREATE_TABLE_SQL[inspector.dialect])) {
    if (await inspector.tableExists(tableName)) continue;
    await inspector.execute(sqlText);
  }

  for (const sqlText of CREATE_INDEX_SQL[inspector.dialect]) {
    try {
      await inspector.execute(sqlText);
    } catch (error) {
      if (isIgnorableExistingObjectError(error)) continue;
      throw error;
    }
  }
}
