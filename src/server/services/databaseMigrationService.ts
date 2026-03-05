import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { db, schema } from '../db/index.js';

export type MigrationDialect = 'sqlite' | 'mysql' | 'postgres';

export interface DatabaseMigrationInput {
  dialect?: unknown;
  connectionString?: unknown;
  overwrite?: unknown;
}

export interface NormalizedDatabaseMigrationInput {
  dialect: MigrationDialect;
  connectionString: string;
  overwrite: boolean;
}

type BackupSnapshot = {
  version: string;
  timestamp: number;
  accounts: {
    sites: Array<Record<string, unknown>>;
    accounts: Array<Record<string, unknown>>;
    accountTokens: Array<Record<string, unknown>>;
    checkinLogs: Array<Record<string, unknown>>;
    modelAvailability: Array<Record<string, unknown>>;
    tokenModelAvailability: Array<Record<string, unknown>>;
    tokenRoutes: Array<Record<string, unknown>>;
    routeChannels: Array<Record<string, unknown>>;
    proxyLogs: Array<Record<string, unknown>>;
    downstreamApiKeys: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
  };
  preferences: {
    settings: Array<{ key: string; value: unknown }>;
  };
};

export interface DatabaseMigrationSummary {
  dialect: MigrationDialect;
  connection: string;
  overwrite: boolean;
  version: string;
  timestamp: number;
  rows: {
    sites: number;
    accounts: number;
    accountTokens: number;
    tokenRoutes: number;
    routeChannels: number;
    checkinLogs: number;
    modelAvailability: number;
    tokenModelAvailability: number;
    proxyLogs: number;
    downstreamApiKeys: number;
    events: number;
    settings: number;
  };
}

interface SqlClient {
  dialect: MigrationDialect;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  execute(sqlText: string, params?: unknown[]): Promise<unknown>;
  queryScalar(sqlText: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

interface InsertStatement {
  table: string;
  columns: string[];
  values: unknown[];
}

const DIALECTS: MigrationDialect[] = ['sqlite', 'mysql', 'postgres'];

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toJsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function assertDialectUrl(dialect: MigrationDialect, connectionString: string): void {
  if (dialect === 'sqlite') return;
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`数据库连接串无效：${dialect} 需要合法 URL`);
  }

  if (dialect === 'postgres' && parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL 连接串必须以 postgres:// 或 postgresql:// 开头');
  }

  if (dialect === 'mysql' && parsed.protocol !== 'mysql:') {
    throw new Error('MySQL 连接串必须以 mysql:// 开头');
  }
}

function normalizeSqliteTarget(raw: string): string {
  if (!raw) throw new Error('SQLite 目标路径不能为空');
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('SQLite 目标路径不能为空');
  if (trimmed === ':memory:') return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('file://')) {
    const parsed = new URL(trimmed);
    return decodeURIComponent(parsed.pathname);
  }
  if (lower.startsWith('sqlite://')) {
    return trimmed.slice('sqlite://'.length).trim();
  }

  // Guard against accidentally saving a network URL under sqlite dialect.
  // This would be treated as a local sqlite file path and produce a broken runtime DB.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error('SQLite 连接串不能是网络 URL，请先选择 MySQL 或 PostgreSQL');
  }
  return trimmed;
}

export function normalizeMigrationInput(input: DatabaseMigrationInput): NormalizedDatabaseMigrationInput {
  const rawDialect = asString(input.dialect).toLowerCase();
  if (!DIALECTS.includes(rawDialect as MigrationDialect)) {
    throw new Error('数据库方言无效，仅支持 sqlite/mysql/postgres');
  }

  const dialect = rawDialect as MigrationDialect;
  let connectionString = asString(input.connectionString);
  if (!connectionString) {
    throw new Error('数据库连接串不能为空');
  }

  if (dialect === 'sqlite') {
    connectionString = normalizeSqliteTarget(connectionString);
  } else {
    assertDialectUrl(dialect, connectionString);
  }

  return {
    dialect,
    connectionString,
    overwrite: input.overwrite === undefined ? true : asBoolean(input.overwrite, true),
  };
}

export function maskConnectionString(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    if (!parsed.password) return connectionString;
    parsed.password = '***';
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

function quoteIdent(dialect: MigrationDialect, identifier: string): string {
  return dialect === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`;
}

function parseSettingValue(raw: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function toBackupSnapshot(): Promise<BackupSnapshot> {
  const settingsRows = await db.select().from(schema.settings).all();
  return {
    version: 'live-db-snapshot',
    timestamp: Date.now(),
    accounts: {
      sites: await db.select().from(schema.sites).all() as Array<Record<string, unknown>>,
      accounts: await db.select().from(schema.accounts).all() as Array<Record<string, unknown>>,
      accountTokens: await db.select().from(schema.accountTokens).all() as Array<Record<string, unknown>>,
      checkinLogs: await db.select().from(schema.checkinLogs).all() as Array<Record<string, unknown>>,
      modelAvailability: await db.select().from(schema.modelAvailability).all() as Array<Record<string, unknown>>,
      tokenModelAvailability: await db.select().from(schema.tokenModelAvailability).all() as Array<Record<string, unknown>>,
      tokenRoutes: await db.select().from(schema.tokenRoutes).all() as Array<Record<string, unknown>>,
      routeChannels: await db.select().from(schema.routeChannels).all() as Array<Record<string, unknown>>,
      proxyLogs: await db.select().from(schema.proxyLogs).all() as Array<Record<string, unknown>>,
      downstreamApiKeys: await db.select().from(schema.downstreamApiKeys).all() as Array<Record<string, unknown>>,
      events: await db.select().from(schema.events).all() as Array<Record<string, unknown>>,
    },
    preferences: {
      settings: settingsRows.map((row) => ({ key: row.key, value: parseSettingValue(row.value) })),
    },
  };
}

async function createPostgresClient(connectionString: string): Promise<SqlClient> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  return {
    dialect: 'postgres',
    begin: async () => { await client.query('BEGIN'); },
    commit: async () => { await client.query('COMMIT'); },
    rollback: async () => { await client.query('ROLLBACK'); },
    execute: async (sqlText, params = []) => client.query(sqlText, params),
    queryScalar: async (sqlText, params = []) => {
      const result = await client.query(sqlText, params);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return 0;
      return Number(Object.values(row)[0]) || 0;
    },
    close: async () => { await client.end(); },
  };
}

async function createMySqlClient(connectionString: string): Promise<SqlClient> {
  const connection = await mysql.createConnection(connectionString);

  return {
    dialect: 'mysql',
    begin: async () => { await connection.beginTransaction(); },
    commit: async () => { await connection.commit(); },
    rollback: async () => { await connection.rollback(); },
    execute: async (sqlText, params = []) => connection.execute(sqlText, params as any[]),
    queryScalar: async (sqlText, params = []) => {
      const [rows] = await connection.query(sqlText, params as any[]);
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      const row = rows[0] as Record<string, unknown>;
      return Number(Object.values(row)[0]) || 0;
    },
    close: async () => { await connection.end(); },
  };
}

async function createSqliteClient(connectionString: string): Promise<SqlClient> {
  const filePath = resolve(connectionString);
  mkdirSync(dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  return {
    dialect: 'sqlite',
    begin: async () => { sqlite.exec('BEGIN'); },
    commit: async () => { sqlite.exec('COMMIT'); },
    rollback: async () => { sqlite.exec('ROLLBACK'); },
    execute: async (sqlText, params = []) => {
      const lowered = sqlText.trim().toLowerCase();
      const stmt = sqlite.prepare(sqlText);
      if (lowered.startsWith('select')) return await stmt.all(...params);
      return await stmt.run(...params);
    },
    queryScalar: async (sqlText, params = []) => {
      const row = await sqlite.prepare(sqlText).get(...params) as Record<string, unknown> | undefined;
      if (!row) return 0;
      return Number(Object.values(row)[0]) || 0;
    },
    close: async () => { sqlite.close(); },
  };
}

async function createClient(input: NormalizedDatabaseMigrationInput): Promise<SqlClient> {
  if (input.dialect === 'postgres') return createPostgresClient(input.connectionString);
  if (input.dialect === 'mysql') return createMySqlClient(input.connectionString);
  return createSqliteClient(input.connectionString);
}

async function ensureSchema(client: SqlClient): Promise<void> {
  const statements = client.dialect === 'postgres'
    ? [
      `CREATE TABLE IF NOT EXISTS "sites" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "name" TEXT NOT NULL, "url" TEXT NOT NULL, "external_checkin_url" TEXT, "platform" TEXT NOT NULL, "proxy_url" TEXT, "status" TEXT DEFAULT 'active', "is_pinned" BOOLEAN DEFAULT FALSE, "sort_order" INTEGER DEFAULT 0, "global_weight" DOUBLE PRECISION DEFAULT 1, "api_key" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "accounts" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "site_id" INTEGER NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE, "username" TEXT, "access_token" TEXT NOT NULL, "api_token" TEXT, "balance" DOUBLE PRECISION DEFAULT 0, "balance_used" DOUBLE PRECISION DEFAULT 0, "quota" DOUBLE PRECISION DEFAULT 0, "unit_cost" DOUBLE PRECISION, "value_score" DOUBLE PRECISION DEFAULT 0, "status" TEXT DEFAULT 'active', "is_pinned" BOOLEAN DEFAULT FALSE, "sort_order" INTEGER DEFAULT 0, "checkin_enabled" BOOLEAN DEFAULT TRUE, "last_checkin_at" TEXT, "last_balance_refresh" TEXT, "extra_config" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "account_tokens" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "token" TEXT NOT NULL, "token_group" TEXT, "source" TEXT DEFAULT 'manual', "enabled" BOOLEAN DEFAULT TRUE, "is_default" BOOLEAN DEFAULT FALSE, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "checkin_logs" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "status" TEXT NOT NULL, "message" TEXT, "reward" TEXT, "created_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "model_availability" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "model_name" TEXT NOT NULL, "available" BOOLEAN, "latency_ms" INTEGER, "checked_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "token_model_availability" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "token_id" INTEGER NOT NULL REFERENCES "account_tokens"("id") ON DELETE CASCADE, "model_name" TEXT NOT NULL, "available" BOOLEAN, "latency_ms" INTEGER, "checked_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "token_routes" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "model_pattern" TEXT NOT NULL, "display_name" TEXT, "display_icon" TEXT, "model_mapping" TEXT, "enabled" BOOLEAN DEFAULT TRUE, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "route_channels" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "route_id" INTEGER NOT NULL REFERENCES "token_routes"("id") ON DELETE CASCADE, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "token_id" INTEGER REFERENCES "account_tokens"("id") ON DELETE SET NULL, "source_model" TEXT, "priority" INTEGER DEFAULT 0, "weight" INTEGER DEFAULT 10, "enabled" BOOLEAN DEFAULT TRUE, "manual_override" BOOLEAN DEFAULT FALSE, "success_count" INTEGER DEFAULT 0, "fail_count" INTEGER DEFAULT 0, "total_latency_ms" INTEGER DEFAULT 0, "total_cost" DOUBLE PRECISION DEFAULT 0, "last_used_at" TEXT, "last_fail_at" TEXT, "cooldown_until" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "proxy_logs" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "route_id" INTEGER, "channel_id" INTEGER, "account_id" INTEGER, "model_requested" TEXT, "model_actual" TEXT, "status" TEXT, "http_status" INTEGER, "latency_ms" INTEGER, "prompt_tokens" INTEGER, "completion_tokens" INTEGER, "total_tokens" INTEGER, "estimated_cost" DOUBLE PRECISION, "error_message" TEXT, "retry_count" INTEGER DEFAULT 0, "created_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "downstream_api_keys" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "name" TEXT NOT NULL, "key" TEXT NOT NULL UNIQUE, "description" TEXT, "enabled" BOOLEAN DEFAULT TRUE, "expires_at" TEXT, "max_cost" DOUBLE PRECISION, "used_cost" DOUBLE PRECISION DEFAULT 0, "max_requests" INTEGER, "used_requests" INTEGER DEFAULT 0, "supported_models" TEXT, "allowed_route_ids" TEXT, "site_weight_multipliers" TEXT, "last_used_at" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "events" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "type" TEXT NOT NULL, "title" TEXT NOT NULL, "message" TEXT, "level" TEXT DEFAULT 'info', "read" BOOLEAN DEFAULT FALSE, "related_id" INTEGER, "related_type" TEXT, "created_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "settings" ("key" TEXT PRIMARY KEY, "value" TEXT)`,
    ]
    : client.dialect === 'mysql'
      ? [
        `CREATE TABLE IF NOT EXISTS \`sites\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`name\` TEXT NOT NULL, \`url\` TEXT NOT NULL, \`external_checkin_url\` TEXT NULL, \`platform\` VARCHAR(64) NOT NULL, \`proxy_url\` TEXT NULL, \`status\` VARCHAR(32) DEFAULT 'active', \`is_pinned\` BOOLEAN DEFAULT FALSE, \`sort_order\` INT DEFAULT 0, \`global_weight\` DOUBLE DEFAULT 1, \`api_key\` TEXT NULL, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`accounts\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`site_id\` INT NOT NULL, \`username\` TEXT NULL, \`access_token\` TEXT NOT NULL, \`api_token\` TEXT NULL, \`balance\` DOUBLE DEFAULT 0, \`balance_used\` DOUBLE DEFAULT 0, \`quota\` DOUBLE DEFAULT 0, \`unit_cost\` DOUBLE NULL, \`value_score\` DOUBLE DEFAULT 0, \`status\` VARCHAR(32) DEFAULT 'active', \`is_pinned\` BOOLEAN DEFAULT FALSE, \`sort_order\` INT DEFAULT 0, \`checkin_enabled\` BOOLEAN DEFAULT TRUE, \`last_checkin_at\` TEXT NULL, \`last_balance_refresh\` TEXT NULL, \`extra_config\` TEXT NULL, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL, CONSTRAINT \`accounts_site_fk\` FOREIGN KEY (\`site_id\`) REFERENCES \`sites\`(\`id\`) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS \`account_tokens\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`account_id\` INT NOT NULL, \`name\` TEXT NOT NULL, \`token\` TEXT NOT NULL, \`token_group\` TEXT NULL, \`source\` VARCHAR(32) DEFAULT 'manual', \`enabled\` BOOLEAN DEFAULT TRUE, \`is_default\` BOOLEAN DEFAULT FALSE, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL, CONSTRAINT \`account_tokens_account_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS \`checkin_logs\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`account_id\` INT NOT NULL, \`status\` VARCHAR(32) NOT NULL, \`message\` TEXT NULL, \`reward\` TEXT NULL, \`created_at\` TEXT NULL, CONSTRAINT \`checkin_logs_account_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS \`model_availability\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`account_id\` INT NOT NULL, \`model_name\` TEXT NOT NULL, \`available\` BOOLEAN NULL, \`latency_ms\` INT NULL, \`checked_at\` TEXT NULL, CONSTRAINT \`model_availability_account_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS \`token_model_availability\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`token_id\` INT NOT NULL, \`model_name\` TEXT NOT NULL, \`available\` BOOLEAN NULL, \`latency_ms\` INT NULL, \`checked_at\` TEXT NULL, CONSTRAINT \`token_model_availability_token_fk\` FOREIGN KEY (\`token_id\`) REFERENCES \`account_tokens\`(\`id\`) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS \`token_routes\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`model_pattern\` TEXT NOT NULL, \`display_name\` TEXT NULL, \`display_icon\` TEXT NULL, \`model_mapping\` TEXT NULL, \`enabled\` BOOLEAN DEFAULT TRUE, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`route_channels\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`route_id\` INT NOT NULL, \`account_id\` INT NOT NULL, \`token_id\` INT NULL, \`source_model\` TEXT NULL, \`priority\` INT DEFAULT 0, \`weight\` INT DEFAULT 10, \`enabled\` BOOLEAN DEFAULT TRUE, \`manual_override\` BOOLEAN DEFAULT FALSE, \`success_count\` INT DEFAULT 0, \`fail_count\` INT DEFAULT 0, \`total_latency_ms\` INT DEFAULT 0, \`total_cost\` DOUBLE DEFAULT 0, \`last_used_at\` TEXT NULL, \`last_fail_at\` TEXT NULL, \`cooldown_until\` TEXT NULL, CONSTRAINT \`route_channels_route_fk\` FOREIGN KEY (\`route_id\`) REFERENCES \`token_routes\`(\`id\`) ON DELETE CASCADE, CONSTRAINT \`route_channels_account_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE, CONSTRAINT \`route_channels_token_fk\` FOREIGN KEY (\`token_id\`) REFERENCES \`account_tokens\`(\`id\`) ON DELETE SET NULL)`,
        `CREATE TABLE IF NOT EXISTS \`proxy_logs\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`route_id\` INT NULL, \`channel_id\` INT NULL, \`account_id\` INT NULL, \`model_requested\` TEXT NULL, \`model_actual\` TEXT NULL, \`status\` VARCHAR(32) NULL, \`http_status\` INT NULL, \`latency_ms\` INT NULL, \`prompt_tokens\` INT NULL, \`completion_tokens\` INT NULL, \`total_tokens\` INT NULL, \`estimated_cost\` DOUBLE NULL, \`error_message\` TEXT NULL, \`retry_count\` INT DEFAULT 0, \`created_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`downstream_api_keys\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`name\` TEXT NOT NULL, \`key\` VARCHAR(191) NOT NULL UNIQUE, \`description\` TEXT NULL, \`enabled\` BOOLEAN DEFAULT TRUE, \`expires_at\` TEXT NULL, \`max_cost\` DOUBLE NULL, \`used_cost\` DOUBLE DEFAULT 0, \`max_requests\` INT NULL, \`used_requests\` INT DEFAULT 0, \`supported_models\` TEXT NULL, \`allowed_route_ids\` TEXT NULL, \`site_weight_multipliers\` TEXT NULL, \`last_used_at\` TEXT NULL, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`events\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`type\` VARCHAR(32) NOT NULL, \`title\` TEXT NOT NULL, \`message\` TEXT NULL, \`level\` VARCHAR(16) DEFAULT 'info', \`read\` BOOLEAN DEFAULT FALSE, \`related_id\` INT NULL, \`related_type\` VARCHAR(32) NULL, \`created_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`settings\` (\`key\` VARCHAR(191) PRIMARY KEY, \`value\` TEXT NULL)`,
      ]
      : [
        `CREATE TABLE IF NOT EXISTS "sites" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "url" TEXT NOT NULL, "external_checkin_url" TEXT, "platform" TEXT NOT NULL, "proxy_url" TEXT, "status" TEXT DEFAULT 'active', "is_pinned" INTEGER DEFAULT 0, "sort_order" INTEGER DEFAULT 0, "global_weight" REAL DEFAULT 1, "api_key" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "accounts" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "site_id" INTEGER NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE, "username" TEXT, "access_token" TEXT NOT NULL, "api_token" TEXT, "balance" REAL DEFAULT 0, "balance_used" REAL DEFAULT 0, "quota" REAL DEFAULT 0, "unit_cost" REAL, "value_score" REAL DEFAULT 0, "status" TEXT DEFAULT 'active', "is_pinned" INTEGER DEFAULT 0, "sort_order" INTEGER DEFAULT 0, "checkin_enabled" INTEGER DEFAULT 1, "last_checkin_at" TEXT, "last_balance_refresh" TEXT, "extra_config" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "account_tokens" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "token" TEXT NOT NULL, "token_group" TEXT, "source" TEXT DEFAULT 'manual', "enabled" INTEGER DEFAULT 1, "is_default" INTEGER DEFAULT 0, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "checkin_logs" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "status" TEXT NOT NULL, "message" TEXT, "reward" TEXT, "created_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "model_availability" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "model_name" TEXT NOT NULL, "available" INTEGER, "latency_ms" INTEGER, "checked_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "token_model_availability" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "token_id" INTEGER NOT NULL REFERENCES "account_tokens"("id") ON DELETE CASCADE, "model_name" TEXT NOT NULL, "available" INTEGER, "latency_ms" INTEGER, "checked_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "token_routes" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "model_pattern" TEXT NOT NULL, "display_name" TEXT, "display_icon" TEXT, "model_mapping" TEXT, "enabled" INTEGER DEFAULT 1, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "route_channels" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "route_id" INTEGER NOT NULL REFERENCES "token_routes"("id") ON DELETE CASCADE, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "token_id" INTEGER REFERENCES "account_tokens"("id") ON DELETE SET NULL, "source_model" TEXT, "priority" INTEGER DEFAULT 0, "weight" INTEGER DEFAULT 10, "enabled" INTEGER DEFAULT 1, "manual_override" INTEGER DEFAULT 0, "success_count" INTEGER DEFAULT 0, "fail_count" INTEGER DEFAULT 0, "total_latency_ms" INTEGER DEFAULT 0, "total_cost" REAL DEFAULT 0, "last_used_at" TEXT, "last_fail_at" TEXT, "cooldown_until" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "proxy_logs" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "route_id" INTEGER, "channel_id" INTEGER, "account_id" INTEGER, "model_requested" TEXT, "model_actual" TEXT, "status" TEXT, "http_status" INTEGER, "latency_ms" INTEGER, "prompt_tokens" INTEGER, "completion_tokens" INTEGER, "total_tokens" INTEGER, "estimated_cost" REAL, "error_message" TEXT, "retry_count" INTEGER DEFAULT 0, "created_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "downstream_api_keys" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "key" TEXT NOT NULL UNIQUE, "description" TEXT, "enabled" INTEGER DEFAULT 1, "expires_at" TEXT, "max_cost" REAL, "used_cost" REAL DEFAULT 0, "max_requests" INTEGER, "used_requests" INTEGER DEFAULT 0, "supported_models" TEXT, "allowed_route_ids" TEXT, "site_weight_multipliers" TEXT, "last_used_at" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "events" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "type" TEXT NOT NULL, "title" TEXT NOT NULL, "message" TEXT, "level" TEXT DEFAULT 'info', "read" INTEGER DEFAULT 0, "related_id" INTEGER, "related_type" TEXT, "created_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "settings" ("key" TEXT PRIMARY KEY, "value" TEXT)`,
      ];

  for (const sqlText of statements) {
    await client.execute(sqlText);
  }
}

async function ensureTargetState(client: SqlClient, overwrite: boolean): Promise<void> {
  const siteCount = await client.queryScalar(`SELECT COUNT(*) FROM ${quoteIdent(client.dialect, 'sites')}`);
  const settingCount = await client.queryScalar(`SELECT COUNT(*) FROM ${quoteIdent(client.dialect, 'settings')}`);
  if (!overwrite && (siteCount > 0 || settingCount > 0)) {
    throw new Error('目标数据库已包含数据。若确认覆盖，请勾选“覆盖目标数据库现有数据”');
  }
}

async function clearTargetData(client: SqlClient): Promise<void> {
  const tables = [
    'route_channels',
    'token_model_availability',
    'model_availability',
    'checkin_logs',
    'proxy_logs',
    'account_tokens',
    'accounts',
    'token_routes',
    'sites',
    'downstream_api_keys',
    'events',
    'settings',
  ];
  for (const table of tables) {
    await client.execute(`DELETE FROM ${quoteIdent(client.dialect, table)}`);
  }
}

function buildStatements(snapshot: BackupSnapshot): InsertStatement[] {
  const statements: InsertStatement[] = [];

  for (const row of snapshot.accounts.sites) {
    statements.push({
      table: 'sites',
      columns: ['id', 'name', 'url', 'external_checkin_url', 'platform', 'proxy_url', 'status', 'is_pinned', 'sort_order', 'global_weight', 'api_key', 'created_at', 'updated_at'],
      values: [
        asNumber(row.id, 0),
        asNullableString(row.name),
        asNullableString(row.url),
        asNullableString(row.externalCheckinUrl),
        asNullableString(row.platform),
        asNullableString(row.proxyUrl),
        asNullableString(row.status) ?? 'active',
        asBoolean(row.isPinned, false),
        asNumber(row.sortOrder, 0),
        asNumber(row.globalWeight, 1),
        asNullableString(row.apiKey),
        asNullableString(row.createdAt),
        asNullableString(row.updatedAt),
      ],
    });
  }

  for (const row of snapshot.accounts.accounts) {
    statements.push({
      table: 'accounts',
      columns: ['id', 'site_id', 'username', 'access_token', 'api_token', 'balance', 'balance_used', 'quota', 'unit_cost', 'value_score', 'status', 'is_pinned', 'sort_order', 'checkin_enabled', 'last_checkin_at', 'last_balance_refresh', 'extra_config', 'created_at', 'updated_at'],
      values: [
        asNumber(row.id, 0),
        asNumber(row.siteId, 0),
        asNullableString(row.username),
        asNullableString(row.accessToken),
        asNullableString(row.apiToken),
        asNumber(row.balance, 0),
        asNumber(row.balanceUsed, 0),
        asNumber(row.quota, 0),
        asNumber(row.unitCost, null),
        asNumber(row.valueScore, 0),
        asNullableString(row.status) ?? 'active',
        asBoolean(row.isPinned, false),
        asNumber(row.sortOrder, 0),
        asBoolean(row.checkinEnabled, true),
        asNullableString(row.lastCheckinAt),
        asNullableString(row.lastBalanceRefresh),
        asNullableString(row.extraConfig),
        asNullableString(row.createdAt),
        asNullableString(row.updatedAt),
      ],
    });
  }

  for (const row of snapshot.accounts.accountTokens) {
    statements.push({
      table: 'account_tokens',
      columns: ['id', 'account_id', 'name', 'token', 'token_group', 'source', 'enabled', 'is_default', 'created_at', 'updated_at'],
      values: [
        asNumber(row.id, 0),
        asNumber(row.accountId, 0),
        asNullableString(row.name),
        asNullableString(row.token),
        asNullableString(row.tokenGroup),
        asNullableString(row.source) ?? 'manual',
        asBoolean(row.enabled, true),
        asBoolean(row.isDefault, false),
        asNullableString(row.createdAt),
        asNullableString(row.updatedAt),
      ],
    });
  }

  for (const row of snapshot.accounts.checkinLogs) {
    statements.push({
      table: 'checkin_logs',
      columns: ['id', 'account_id', 'status', 'message', 'reward', 'created_at'],
      values: [
        asNumber(row.id, 0),
        asNumber(row.accountId, 0),
        asNullableString(row.status) ?? 'success',
        asNullableString(row.message),
        asNullableString(row.reward),
        asNullableString(row.createdAt),
      ],
    });
  }

  for (const row of snapshot.accounts.modelAvailability) {
    statements.push({
      table: 'model_availability',
      columns: ['id', 'account_id', 'model_name', 'available', 'latency_ms', 'checked_at'],
      values: [
        asNumber(row.id, 0),
        asNumber(row.accountId, 0),
        asNullableString(row.modelName),
        asBoolean(row.available, false),
        asNumber(row.latencyMs, null),
        asNullableString(row.checkedAt),
      ],
    });
  }

  for (const row of snapshot.accounts.tokenModelAvailability) {
    statements.push({
      table: 'token_model_availability',
      columns: ['id', 'token_id', 'model_name', 'available', 'latency_ms', 'checked_at'],
      values: [
        asNumber(row.id, 0),
        asNumber(row.tokenId, 0),
        asNullableString(row.modelName),
        asBoolean(row.available, false),
        asNumber(row.latencyMs, null),
        asNullableString(row.checkedAt),
      ],
    });
  }

  for (const row of snapshot.accounts.tokenRoutes) {
    statements.push({
      table: 'token_routes',
      columns: ['id', 'model_pattern', 'display_name', 'display_icon', 'model_mapping', 'enabled', 'created_at', 'updated_at'],
      values: [
        asNumber(row.id, 0),
        asNullableString(row.modelPattern),
        asNullableString(row.displayName),
        asNullableString(row.displayIcon),
        asNullableString(row.modelMapping),
        asBoolean(row.enabled, true),
        asNullableString(row.createdAt),
        asNullableString(row.updatedAt),
      ],
    });
  }

  for (const row of snapshot.accounts.routeChannels) {
    statements.push({
      table: 'route_channels',
      columns: ['id', 'route_id', 'account_id', 'token_id', 'source_model', 'priority', 'weight', 'enabled', 'manual_override', 'success_count', 'fail_count', 'total_latency_ms', 'total_cost', 'last_used_at', 'last_fail_at', 'cooldown_until'],
      values: [
        asNumber(row.id, 0),
        asNumber(row.routeId, 0),
        asNumber(row.accountId, 0),
        asNumber(row.tokenId, null),
        asNullableString(row.sourceModel),
        asNumber(row.priority, 0),
        asNumber(row.weight, 10),
        asBoolean(row.enabled, true),
        asBoolean(row.manualOverride, false),
        asNumber(row.successCount, 0),
        asNumber(row.failCount, 0),
        asNumber(row.totalLatencyMs, 0),
        asNumber(row.totalCost, 0),
        asNullableString(row.lastUsedAt),
        asNullableString(row.lastFailAt),
        asNullableString(row.cooldownUntil),
      ],
    });
  }

  for (const row of snapshot.accounts.proxyLogs) {
    statements.push({
      table: 'proxy_logs',
      columns: ['id', 'route_id', 'channel_id', 'account_id', 'model_requested', 'model_actual', 'status', 'http_status', 'latency_ms', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'estimated_cost', 'error_message', 'retry_count', 'created_at'],
      values: [
        asNumber(row.id, 0),
        asNumber(row.routeId, null),
        asNumber(row.channelId, null),
        asNumber(row.accountId, null),
        asNullableString(row.modelRequested),
        asNullableString(row.modelActual),
        asNullableString(row.status),
        asNumber(row.httpStatus, null),
        asNumber(row.latencyMs, null),
        asNumber(row.promptTokens, null),
        asNumber(row.completionTokens, null),
        asNumber(row.totalTokens, null),
        asNumber(row.estimatedCost, null),
        asNullableString(row.errorMessage),
        asNumber(row.retryCount, 0),
        asNullableString(row.createdAt),
      ],
    });
  }

  for (const row of snapshot.accounts.downstreamApiKeys) {
    statements.push({
      table: 'downstream_api_keys',
      columns: ['id', 'name', 'key', 'description', 'enabled', 'expires_at', 'max_cost', 'used_cost', 'max_requests', 'used_requests', 'supported_models', 'allowed_route_ids', 'site_weight_multipliers', 'last_used_at', 'created_at', 'updated_at'],
      values: [
        asNumber(row.id, 0),
        asNullableString(row.name),
        asNullableString(row.key),
        asNullableString(row.description),
        asBoolean(row.enabled, true),
        asNullableString(row.expiresAt),
        asNumber(row.maxCost, null),
        asNumber(row.usedCost, 0),
        asNumber(row.maxRequests, null),
        asNumber(row.usedRequests, 0),
        asNullableString(row.supportedModels),
        asNullableString(row.allowedRouteIds),
        asNullableString(row.siteWeightMultipliers),
        asNullableString(row.lastUsedAt),
        asNullableString(row.createdAt),
        asNullableString(row.updatedAt),
      ],
    });
  }

  for (const row of snapshot.accounts.events) {
    statements.push({
      table: 'events',
      columns: ['id', 'type', 'title', 'message', 'level', 'read', 'related_id', 'related_type', 'created_at'],
      values: [
        asNumber(row.id, 0),
        asNullableString(row.type),
        asNullableString(row.title),
        asNullableString(row.message),
        asNullableString(row.level) ?? 'info',
        asBoolean(row.read, false),
        asNumber(row.relatedId, null),
        asNullableString(row.relatedType),
        asNullableString(row.createdAt),
      ],
    });
  }

  for (const row of snapshot.preferences.settings) {
    statements.push({
      table: 'settings',
      columns: ['key', 'value'],
      values: [row.key, toJsonString(row.value)],
    });
  }

  return statements;
}

function buildInsertSql(dialect: MigrationDialect, statement: InsertStatement): { sqlText: string; params: unknown[] } {
  const table = quoteIdent(dialect, statement.table);
  const columns = statement.columns.map((item) => quoteIdent(dialect, item)).join(', ');
  const placeholders = statement.columns.map((_, index) => (dialect === 'postgres' ? `$${index + 1}` : '?')).join(', ');
  const params = statement.values.map((value) => {
    if (dialect === 'sqlite' && typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    return value;
  });
  return {
    sqlText: `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`,
    params,
  };
}

async function insertAllRows(client: SqlClient, statements: InsertStatement[]): Promise<void> {
  for (const statement of statements) {
    const { sqlText, params } = buildInsertSql(client.dialect, statement);
    await client.execute(sqlText, params);
  }
}

async function syncPostgresSequences(client: SqlClient): Promise<void> {
  if (client.dialect !== 'postgres') return;
  const tables = [
    'sites',
    'accounts',
    'account_tokens',
    'checkin_logs',
    'model_availability',
    'token_model_availability',
    'token_routes',
    'route_channels',
    'proxy_logs',
    'downstream_api_keys',
    'events',
  ];
  for (const table of tables) {
    await client.execute(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1), TRUE)`);
  }
}

export async function migrateCurrentDatabase(input: DatabaseMigrationInput): Promise<DatabaseMigrationSummary> {
  const normalized = normalizeMigrationInput(input);
  const snapshot = await toBackupSnapshot();
  const client = await createClient(normalized);

  try {
    await ensureSchema(client);
    await ensureTargetState(client, normalized.overwrite);

    await client.begin();
    try {
      if (normalized.overwrite) {
        await clearTargetData(client);
      }
      await insertAllRows(client, buildStatements(snapshot));
      await syncPostgresSequences(client);
      await client.commit();
    } catch (error) {
      await client.rollback();
      throw error;
    }
  } finally {
    await client.close();
  }

  return {
    dialect: normalized.dialect,
    connection: maskConnectionString(normalized.connectionString),
    overwrite: normalized.overwrite,
    version: snapshot.version,
    timestamp: snapshot.timestamp,
    rows: {
      sites: snapshot.accounts.sites.length,
      accounts: snapshot.accounts.accounts.length,
      accountTokens: snapshot.accounts.accountTokens.length,
      tokenRoutes: snapshot.accounts.tokenRoutes.length,
      routeChannels: snapshot.accounts.routeChannels.length,
      checkinLogs: snapshot.accounts.checkinLogs.length,
      modelAvailability: snapshot.accounts.modelAvailability.length,
      tokenModelAvailability: snapshot.accounts.tokenModelAvailability.length,
      proxyLogs: snapshot.accounts.proxyLogs.length,
      downstreamApiKeys: snapshot.accounts.downstreamApiKeys.length,
      events: snapshot.accounts.events.length,
      settings: snapshot.preferences.settings.length,
    },
  };
}

export async function testDatabaseConnection(input: DatabaseMigrationInput): Promise<{ dialect: MigrationDialect; connection: string }> {
  const normalized = normalizeMigrationInput(input);
  const client = await createClient(normalized);
  try {
    await client.execute('SELECT 1');
  } finally {
    await client.close();
  }

  return {
    dialect: normalized.dialect,
    connection: maskConnectionString(normalized.connectionString),
  };
}

