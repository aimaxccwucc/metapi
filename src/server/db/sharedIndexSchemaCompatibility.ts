export type SharedIndexSchemaDialect = 'sqlite' | 'mysql' | 'postgres';

export interface SharedIndexSchemaInspector {
  dialect: SharedIndexSchemaDialect;
  tableExists(table: string): Promise<boolean>;
  execute(sqlText: string): Promise<void>;
  dedupeForUniqueIndex?(table: string, indexName: string): Promise<void>;
}

type SharedIndexCompatibilitySpec = {
  table: string;
  indexName: string;
  createSql: Record<SharedIndexSchemaDialect, string>;
};

export const SHARED_INDEX_COMPATIBILITY_SPECS: SharedIndexCompatibilitySpec[] = [
  {
    table: 'sites',
    indexName: 'sites_status_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS sites_status_idx ON sites (status);',
      mysql: 'CREATE INDEX `sites_status_idx` ON `sites` (`status`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "sites_status_idx" ON "sites" ("status")',
    },
  },
  {
    table: 'accounts',
    indexName: 'accounts_site_id_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS accounts_site_id_idx ON accounts (site_id);',
      mysql: 'CREATE INDEX `accounts_site_id_idx` ON `accounts` (`site_id`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "accounts_site_id_idx" ON "accounts" ("site_id")',
    },
  },
  {
    table: 'accounts',
    indexName: 'accounts_status_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS accounts_status_idx ON accounts (status);',
      mysql: 'CREATE INDEX `accounts_status_idx` ON `accounts` (`status`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "accounts_status_idx" ON "accounts" ("status")',
    },
  },
  {
    table: 'accounts',
    indexName: 'accounts_site_status_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS accounts_site_status_idx ON accounts (site_id, status);',
      mysql: 'CREATE INDEX `accounts_site_status_idx` ON `accounts` (`site_id`, `status`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "accounts_site_status_idx" ON "accounts" ("site_id", "status")',
    },
  },
  {
    table: 'account_tokens',
    indexName: 'account_tokens_account_id_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS account_tokens_account_id_idx ON account_tokens (account_id);',
      mysql: 'CREATE INDEX `account_tokens_account_id_idx` ON `account_tokens` (`account_id`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "account_tokens_account_id_idx" ON "account_tokens" ("account_id")',
    },
  },
  {
    table: 'account_tokens',
    indexName: 'account_tokens_account_enabled_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS account_tokens_account_enabled_idx ON account_tokens (account_id, enabled);',
      mysql: 'CREATE INDEX `account_tokens_account_enabled_idx` ON `account_tokens` (`account_id`, `enabled`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "account_tokens_account_enabled_idx" ON "account_tokens" ("account_id", "enabled")',
    },
  },
  {
    table: 'account_tokens',
    indexName: 'account_tokens_enabled_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS account_tokens_enabled_idx ON account_tokens (enabled);',
      mysql: 'CREATE INDEX `account_tokens_enabled_idx` ON `account_tokens` (`enabled`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "account_tokens_enabled_idx" ON "account_tokens" ("enabled")',
    },
  },
  {
    table: 'checkin_logs',
    indexName: 'checkin_logs_account_created_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS checkin_logs_account_created_at_idx ON checkin_logs (account_id, created_at);',
      mysql: 'CREATE INDEX `checkin_logs_account_created_at_idx` ON `checkin_logs` (`account_id`, `created_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "checkin_logs_account_created_at_idx" ON "checkin_logs" ("account_id", "created_at")',
    },
  },
  {
    table: 'checkin_logs',
    indexName: 'checkin_logs_created_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS checkin_logs_created_at_idx ON checkin_logs (created_at);',
      mysql: 'CREATE INDEX `checkin_logs_created_at_idx` ON `checkin_logs` (`created_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "checkin_logs_created_at_idx" ON "checkin_logs" ("created_at")',
    },
  },
  {
    table: 'checkin_logs',
    indexName: 'checkin_logs_status_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS checkin_logs_status_idx ON checkin_logs (status);',
      mysql: 'CREATE INDEX `checkin_logs_status_idx` ON `checkin_logs` (`status`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "checkin_logs_status_idx" ON "checkin_logs" ("status")',
    },
  },
  {
    table: 'model_availability',
    indexName: 'model_availability_account_model_unique',
    createSql: {
      sqlite: 'CREATE UNIQUE INDEX IF NOT EXISTS model_availability_account_model_unique ON model_availability (account_id, model_name);',
      mysql: 'CREATE UNIQUE INDEX `model_availability_account_model_unique` ON `model_availability` (`account_id`, `model_name`(191))',
      postgres: 'CREATE UNIQUE INDEX IF NOT EXISTS "model_availability_account_model_unique" ON "model_availability" ("account_id", "model_name")',
    },
  },
  {
    table: 'model_availability',
    indexName: 'model_availability_account_available_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS model_availability_account_available_idx ON model_availability (account_id, available);',
      mysql: 'CREATE INDEX `model_availability_account_available_idx` ON `model_availability` (`account_id`, `available`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "model_availability_account_available_idx" ON "model_availability" ("account_id", "available")',
    },
  },
  {
    table: 'model_availability',
    indexName: 'model_availability_model_name_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS model_availability_model_name_idx ON model_availability (model_name);',
      mysql: 'CREATE INDEX `model_availability_model_name_idx` ON `model_availability` (`model_name`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "model_availability_model_name_idx" ON "model_availability" ("model_name")',
    },
  },
  {
    table: 'token_model_availability',
    indexName: 'token_model_availability_token_model_unique',
    createSql: {
      sqlite: 'CREATE UNIQUE INDEX IF NOT EXISTS token_model_availability_token_model_unique ON token_model_availability (token_id, model_name);',
      mysql: 'CREATE UNIQUE INDEX `token_model_availability_token_model_unique` ON `token_model_availability` (`token_id`, `model_name`(191))',
      postgres: 'CREATE UNIQUE INDEX IF NOT EXISTS "token_model_availability_token_model_unique" ON "token_model_availability" ("token_id", "model_name")',
    },
  },
  {
    table: 'token_model_availability',
    indexName: 'token_model_availability_token_available_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS token_model_availability_token_available_idx ON token_model_availability (token_id, available);',
      mysql: 'CREATE INDEX `token_model_availability_token_available_idx` ON `token_model_availability` (`token_id`, `available`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "token_model_availability_token_available_idx" ON "token_model_availability" ("token_id", "available")',
    },
  },
  {
    table: 'token_model_availability',
    indexName: 'token_model_availability_model_name_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS token_model_availability_model_name_idx ON token_model_availability (model_name);',
      mysql: 'CREATE INDEX `token_model_availability_model_name_idx` ON `token_model_availability` (`model_name`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "token_model_availability_model_name_idx" ON "token_model_availability" ("model_name")',
    },
  },
  {
    table: 'token_model_availability',
    indexName: 'token_model_availability_available_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS token_model_availability_available_idx ON token_model_availability (available);',
      mysql: 'CREATE INDEX `token_model_availability_available_idx` ON `token_model_availability` (`available`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "token_model_availability_available_idx" ON "token_model_availability" ("available")',
    },
  },
  {
    table: 'token_routes',
    indexName: 'token_routes_model_pattern_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS token_routes_model_pattern_idx ON token_routes (model_pattern);',
      mysql: 'CREATE INDEX `token_routes_model_pattern_idx` ON `token_routes` (`model_pattern`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "token_routes_model_pattern_idx" ON "token_routes" ("model_pattern")',
    },
  },
  {
    table: 'token_routes',
    indexName: 'token_routes_enabled_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS token_routes_enabled_idx ON token_routes (enabled);',
      mysql: 'CREATE INDEX `token_routes_enabled_idx` ON `token_routes` (`enabled`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "token_routes_enabled_idx" ON "token_routes" ("enabled")',
    },
  },
  {
    table: 'route_channels',
    indexName: 'route_channels_route_id_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS route_channels_route_id_idx ON route_channels (route_id);',
      mysql: 'CREATE INDEX `route_channels_route_id_idx` ON `route_channels` (`route_id`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "route_channels_route_id_idx" ON "route_channels" ("route_id")',
    },
  },
  {
    table: 'route_channels',
    indexName: 'route_channels_account_id_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS route_channels_account_id_idx ON route_channels (account_id);',
      mysql: 'CREATE INDEX `route_channels_account_id_idx` ON `route_channels` (`account_id`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "route_channels_account_id_idx" ON "route_channels" ("account_id")',
    },
  },
  {
    table: 'route_channels',
    indexName: 'route_channels_token_id_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS route_channels_token_id_idx ON route_channels (token_id);',
      mysql: 'CREATE INDEX `route_channels_token_id_idx` ON `route_channels` (`token_id`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "route_channels_token_id_idx" ON "route_channels" ("token_id")',
    },
  },
  {
    table: 'route_channels',
    indexName: 'route_channels_route_enabled_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS route_channels_route_enabled_idx ON route_channels (route_id, enabled);',
      mysql: 'CREATE INDEX `route_channels_route_enabled_idx` ON `route_channels` (`route_id`, `enabled`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "route_channels_route_enabled_idx" ON "route_channels" ("route_id", "enabled")',
    },
  },
  {
    table: 'route_channels',
    indexName: 'route_channels_route_token_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS route_channels_route_token_idx ON route_channels (route_id, token_id);',
      mysql: 'CREATE INDEX `route_channels_route_token_idx` ON `route_channels` (`route_id`, `token_id`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "route_channels_route_token_idx" ON "route_channels" ("route_id", "token_id")',
    },
  },
  {
    table: 'proxy_logs',
    indexName: 'proxy_logs_created_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS proxy_logs_created_at_idx ON proxy_logs (created_at);',
      mysql: 'CREATE INDEX `proxy_logs_created_at_idx` ON `proxy_logs` (`created_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "proxy_logs_created_at_idx" ON "proxy_logs" ("created_at")',
    },
  },
  {
    table: 'proxy_logs',
    indexName: 'proxy_logs_account_created_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS proxy_logs_account_created_at_idx ON proxy_logs (account_id, created_at);',
      mysql: 'CREATE INDEX `proxy_logs_account_created_at_idx` ON `proxy_logs` (`account_id`, `created_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "proxy_logs_account_created_at_idx" ON "proxy_logs" ("account_id", "created_at")',
    },
  },
  {
    table: 'proxy_logs',
    indexName: 'proxy_logs_status_created_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS proxy_logs_status_created_at_idx ON proxy_logs (status, created_at);',
      mysql: 'CREATE INDEX `proxy_logs_status_created_at_idx` ON `proxy_logs` (`status`, `created_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "proxy_logs_status_created_at_idx" ON "proxy_logs" ("status", "created_at")',
    },
  },
  {
    table: 'proxy_logs',
    indexName: 'proxy_logs_model_actual_created_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS proxy_logs_model_actual_created_at_idx ON proxy_logs (model_actual, created_at);',
      mysql: 'CREATE INDEX `proxy_logs_model_actual_created_at_idx` ON `proxy_logs` (`model_actual`(191), `created_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "proxy_logs_model_actual_created_at_idx" ON "proxy_logs" ("model_actual", "created_at")',
    },
  },
  {
    table: 'proxy_video_tasks',
    indexName: 'proxy_video_tasks_upstream_video_id_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS proxy_video_tasks_upstream_video_id_idx ON proxy_video_tasks (upstream_video_id);',
      mysql: 'CREATE INDEX `proxy_video_tasks_upstream_video_id_idx` ON `proxy_video_tasks` (`upstream_video_id`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "proxy_video_tasks_upstream_video_id_idx" ON "proxy_video_tasks" ("upstream_video_id")',
    },
  },
  {
    table: 'proxy_video_tasks',
    indexName: 'proxy_video_tasks_created_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS proxy_video_tasks_created_at_idx ON proxy_video_tasks (created_at);',
      mysql: 'CREATE INDEX `proxy_video_tasks_created_at_idx` ON `proxy_video_tasks` (`created_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "proxy_video_tasks_created_at_idx" ON "proxy_video_tasks" ("created_at")',
    },
  },
  {
    table: 'downstream_api_keys',
    indexName: 'downstream_api_keys_name_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS downstream_api_keys_name_idx ON downstream_api_keys (name);',
      mysql: 'CREATE INDEX `downstream_api_keys_name_idx` ON `downstream_api_keys` (`name`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "downstream_api_keys_name_idx" ON "downstream_api_keys" ("name")',
    },
  },
  {
    table: 'downstream_api_keys',
    indexName: 'downstream_api_keys_enabled_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS downstream_api_keys_enabled_idx ON downstream_api_keys (enabled);',
      mysql: 'CREATE INDEX `downstream_api_keys_enabled_idx` ON `downstream_api_keys` (`enabled`)',
      postgres: 'CREATE INDEX IF NOT EXISTS "downstream_api_keys_enabled_idx" ON "downstream_api_keys" ("enabled")',
    },
  },
  {
    table: 'downstream_api_keys',
    indexName: 'downstream_api_keys_expires_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS downstream_api_keys_expires_at_idx ON downstream_api_keys (expires_at);',
      mysql: 'CREATE INDEX `downstream_api_keys_expires_at_idx` ON `downstream_api_keys` (`expires_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "downstream_api_keys_expires_at_idx" ON "downstream_api_keys" ("expires_at")',
    },
  },
  {
    table: 'events',
    indexName: 'events_read_created_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS events_read_created_at_idx ON events (read, created_at);',
      mysql: 'CREATE INDEX `events_read_created_at_idx` ON `events` (`read`, `created_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "events_read_created_at_idx" ON "events" ("read", "created_at")',
    },
  },
  {
    table: 'events',
    indexName: 'events_type_created_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS events_type_created_at_idx ON events (type, created_at);',
      mysql: 'CREATE INDEX `events_type_created_at_idx` ON `events` (`type`, `created_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "events_type_created_at_idx" ON "events" ("type", "created_at")',
    },
  },
  {
    table: 'events',
    indexName: 'events_created_at_idx',
    createSql: {
      sqlite: 'CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at);',
      mysql: 'CREATE INDEX `events_created_at_idx` ON `events` (`created_at`(191))',
      postgres: 'CREATE INDEX IF NOT EXISTS "events_created_at_idx" ON "events" ("created_at")',
    },
  },
];

function normalizeSchemaErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message?: unknown }).message || '');
  }
  return String(error || '');
}

function isDuplicateSchemaError(error: unknown): boolean {
  const lowered = normalizeSchemaErrorMessage(error).toLowerCase();
  return lowered.includes('already exists')
    || lowered.includes('duplicate')
    || lowered.includes('relation') && lowered.includes('already exists');
}

async function executeIgnoreDuplicate(inspector: SharedIndexSchemaInspector, sqlText: string): Promise<void> {
  try {
    await inspector.execute(sqlText);
  } catch (error) {
    if (!isDuplicateSchemaError(error)) {
      throw error;
    }
  }
}

async function prepareIndexCompatibility(inspector: SharedIndexSchemaInspector, spec: SharedIndexCompatibilitySpec): Promise<void> {
  if (!inspector.dedupeForUniqueIndex) return;
  await inspector.dedupeForUniqueIndex(spec.table, spec.indexName);
}

export async function ensureSharedIndexSchemaCompatibility(inspector: SharedIndexSchemaInspector): Promise<void> {
  const tableExistsCache = new Map<string, boolean>();

  for (const spec of SHARED_INDEX_COMPATIBILITY_SPECS) {
    let hasTable = tableExistsCache.get(spec.table);
    if (hasTable === undefined) {
      hasTable = await inspector.tableExists(spec.table);
      tableExistsCache.set(spec.table, hasTable);
    }
    if (!hasTable) {
      continue;
    }

    await prepareIndexCompatibility(inspector, spec);
    await executeIgnoreDuplicate(inspector, spec.createSql[inspector.dialect]);
  }
}
