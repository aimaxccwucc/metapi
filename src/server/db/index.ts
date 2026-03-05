import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { drizzle as drizzleSqliteProxy } from 'drizzle-orm/sqlite-proxy';
import { drizzle as drizzleMysqlProxy } from 'drizzle-orm/mysql-proxy';
import { drizzle as drizzlePgProxy } from 'drizzle-orm/pg-proxy';
import * as schema from './schema.js';
import { config } from '../config.js';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

export type RuntimeDbDialect = 'sqlite' | 'mysql' | 'postgres';
type SqlMethod = 'all' | 'get' | 'run' | 'values' | 'execute';

const TABLES_WITH_NUMERIC_ID = new Set([
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
]);

export let runtimeDbDialect: RuntimeDbDialect = config.dbType;

let sqliteConnection: Database.Database | null = null;
let mysqlPool: mysql.Pool | null = null;
let pgPool: pg.Pool | null = null;

function resolveSqlitePath(): string {
  const raw = (config.dbUrl || '').trim();
  if (!raw) return resolve(`${config.dataDir}/hub.db`);
  if (raw === ':memory:') return raw;
  if (raw.startsWith('file://')) {
    const parsed = new URL(raw);
    return decodeURIComponent(parsed.pathname);
  }
  if (raw.startsWith('sqlite://')) {
    return resolve(raw.slice('sqlite://'.length).trim());
  }
  return resolve(raw);
}

function requireSqliteConnection(): Database.Database {
  if (!sqliteConnection) {
    throw new Error('SQLite connection is not initialized');
  }
  return sqliteConnection;
}

function tableExists(table: string): boolean {
  const sqlite = requireSqliteConnection();
  const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { name?: string } | undefined;
  return !!row?.name;
}

function tableColumnExists(table: string, column: string): boolean {
  const sqlite = requireSqliteConnection();
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === column);
}

function ensureTokenManagementSchema() {
  const sqlite = requireSqliteConnection();
  if (!tableExists('accounts') || !tableExists('route_channels')) {
    return;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS account_tokens (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      account_id integer NOT NULL,
      name text NOT NULL,
      token text NOT NULL,
      token_group text,
      source text DEFAULT 'manual',
      enabled integer DEFAULT true,
      is_default integer DEFAULT false,
      created_at text DEFAULT (datetime('now')),
      updated_at text DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE cascade
    );
  `);

  if (!tableColumnExists('route_channels', 'token_id')) {
    sqlite.exec('ALTER TABLE route_channels ADD COLUMN token_id integer;');
  }

  if (!tableColumnExists('account_tokens', 'token_group')) {
    sqlite.exec('ALTER TABLE account_tokens ADD COLUMN token_group text;');
  }

  sqlite.exec(`
    INSERT INTO account_tokens (account_id, name, token, source, enabled, is_default, created_at, updated_at)
    SELECT
      a.id,
      'default',
      a.api_token,
      'legacy',
      true,
      true,
      datetime('now'),
      datetime('now')
    FROM accounts AS a
    WHERE
      a.api_token IS NOT NULL
      AND trim(a.api_token) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM account_tokens AS t
        WHERE t.account_id = a.id
        AND t.token = a.api_token
      );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS token_model_availability (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      token_id integer NOT NULL,
      model_name text NOT NULL,
      available integer,
      latency_ms integer,
      checked_at text DEFAULT (datetime('now')),
      FOREIGN KEY (token_id) REFERENCES account_tokens(id) ON DELETE cascade
    );
  `);

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS token_model_availability_token_model_unique
    ON token_model_availability(token_id, model_name);
  `);
}

function ensureSiteStatusSchema() {
  const sqlite = requireSqliteConnection();
  if (!tableExists('sites')) {
    return;
  }

  if (!tableColumnExists('sites', 'status')) {
    sqlite.exec(`ALTER TABLE sites ADD COLUMN status text DEFAULT 'active';`);
  }

  sqlite.exec(`
    UPDATE sites
    SET status = lower(trim(status))
    WHERE status IS NOT NULL
      AND lower(trim(status)) IN ('active', 'disabled')
      AND status != lower(trim(status));
  `);

  sqlite.exec(`
    UPDATE sites
    SET status = 'active'
    WHERE status IS NULL
      OR trim(status) = ''
      OR lower(trim(status)) NOT IN ('active', 'disabled');
  `);
}

function ensureSiteProxySchema() {
  const sqlite = requireSqliteConnection();
  if (!tableExists('sites')) {
    return;
  }

  if (!tableColumnExists('sites', 'proxy_url')) {
    sqlite.exec(`ALTER TABLE sites ADD COLUMN proxy_url text;`);
  }
}

function ensureSiteExternalCheckinUrlSchema() {
  const sqlite = requireSqliteConnection();
  if (!tableExists('sites')) {
    return;
  }

  if (!tableColumnExists('sites', 'external_checkin_url')) {
    sqlite.exec(`ALTER TABLE sites ADD COLUMN external_checkin_url text;`);
  }
}

function ensureSiteGlobalWeightSchema() {
  const sqlite = requireSqliteConnection();
  if (!tableExists('sites')) {
    return;
  }

  if (!tableColumnExists('sites', 'global_weight')) {
    sqlite.exec(`ALTER TABLE sites ADD COLUMN global_weight real DEFAULT 1;`);
  }

  sqlite.exec(`
    UPDATE sites
    SET global_weight = 1
    WHERE global_weight IS NULL
      OR global_weight <= 0;
  `);
}

function ensureRouteGroupingSchema() {
  const sqlite = requireSqliteConnection();
  if (!tableExists('token_routes') || !tableExists('route_channels')) {
    return;
  }

  if (!tableColumnExists('token_routes', 'display_name')) {
    sqlite.exec(`ALTER TABLE token_routes ADD COLUMN display_name text;`);
  }

  if (!tableColumnExists('token_routes', 'display_icon')) {
    sqlite.exec(`ALTER TABLE token_routes ADD COLUMN display_icon text;`);
  }

  if (!tableColumnExists('route_channels', 'source_model')) {
    sqlite.exec(`ALTER TABLE route_channels ADD COLUMN source_model text;`);
  }
}

function ensureDownstreamApiKeySchema() {
  const sqlite = requireSqliteConnection();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS downstream_api_keys (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      name text NOT NULL,
      key text NOT NULL,
      description text,
      enabled integer DEFAULT true,
      expires_at text,
      max_cost real,
      used_cost real DEFAULT 0,
      max_requests integer,
      used_requests integer DEFAULT 0,
      supported_models text,
      allowed_route_ids text,
      site_weight_multipliers text,
      last_used_at text,
      created_at text DEFAULT (datetime('now')),
      updated_at text DEFAULT (datetime('now'))
    );
  `);

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS downstream_api_keys_key_unique
    ON downstream_api_keys(key);
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS downstream_api_keys_name_idx
    ON downstream_api_keys(name);
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS downstream_api_keys_enabled_idx
    ON downstream_api_keys(enabled);
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS downstream_api_keys_expires_at_idx
    ON downstream_api_keys(expires_at);
  `);
}

async function sqliteProxyQuery(sqlText: string, params: unknown[], method: SqlMethod) {
  const sqlite = requireSqliteConnection();
  const statement = sqlite.prepare(sqlText);
  if (method === 'run' || method === 'execute') {
    const result = statement.run(...params);
    return {
      rows: [],
      changes: Number(result.changes || 0),
      lastInsertRowid: Number(result.lastInsertRowid || 0),
    };
  }

  if (method === 'get') {
    const row = statement.raw().get(...params) as unknown[] | undefined;
    return { rows: row as any };
  }

  const rows = statement.raw().all(...params) as unknown[][];
  return { rows };
}

type MysqlQueryable = mysql.Pool | mysql.PoolConnection;
async function mysqlProxyQuery(executor: MysqlQueryable, sqlText: string, params: unknown[], method: SqlMethod) {
  const queryOptions = {
    sql: sqlText,
    rowsAsArray: method === 'all' || method === 'values',
  };
  const [rows] = await executor.query(queryOptions as mysql.QueryOptions, params as any[]);

  if (method === 'all' || method === 'values') {
    return { rows: Array.isArray(rows) ? rows : [] };
  }

  if (Array.isArray(rows)) {
    return { rows };
  }
  return { rows: [rows] };
}

type PgQueryable = pg.Pool | pg.PoolClient;
function parseInsertTableName(sqlText: string): string | null {
  const match = sqlText.match(/insert\s+into\s+"?([a-zA-Z0-9_]+)"?/i);
  return match?.[1]?.toLowerCase() || null;
}

async function pgProxyQuery(executor: PgQueryable, sqlText: string, params: unknown[], method: SqlMethod) {
  const trimmedLower = sqlText.trim().toLowerCase();
  const values = params as any[];

  if (method === 'all' || method === 'values') {
    const result = await executor.query({
      text: sqlText,
      values,
      rowMode: 'array',
    } as pg.QueryConfig);
    return { rows: result.rows };
  }

  if (trimmedLower.startsWith('insert') && method === 'execute') {
    const tableName = parseInsertTableName(sqlText);
    const canReturnId = tableName !== null && TABLES_WITH_NUMERIC_ID.has(tableName) && !trimmedLower.includes(' returning ');
    if (canReturnId) {
      const result = await executor.query({
        text: `${sqlText} returning id`,
        values,
      } as pg.QueryConfig);
      const insertedId = Number((result.rows?.[0] as { id?: unknown } | undefined)?.id ?? 0);
      return {
        rows: [{
          changes: Number(result.rowCount || 0),
          lastInsertRowid: Number.isFinite(insertedId) ? insertedId : 0,
        }],
      };
    }
  }

  const result = await executor.query({
    text: sqlText,
    values,
  } as pg.QueryConfig);

  if (trimmedLower.startsWith('select')) {
    return { rows: result.rows };
  }

  return { rows: [{ changes: Number(result.rowCount || 0) }] };
}

function normalizeAllResult(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  if (result.length === 0) return [];
  const first = result[0] as Record<string, unknown> | undefined;
  if (first && typeof first === 'object') {
    if ('affectedRows' in first || 'insertId' in first) return [];
    if ('changes' in first && result.length === 1) return [];
    if ('rowCount' in first && result.length === 1) return [];
  }
  return result;
}

function normalizeRunResult(result: unknown): { changes: number; lastInsertRowid: number } {
  if (!result) return { changes: 0, lastInsertRowid: 0 };

  if (typeof result === 'object' && !Array.isArray(result)) {
    const row = result as Record<string, unknown>;
    if ('changes' in row || 'lastInsertRowid' in row) {
      return {
        changes: Number(row.changes || 0),
        lastInsertRowid: Number(row.lastInsertRowid || 0),
      };
    }
    if ('affectedRows' in row || 'insertId' in row) {
      return {
        changes: Number(row.affectedRows || 0),
        lastInsertRowid: Number(row.insertId || 0),
      };
    }
  }

  if (Array.isArray(result) && result.length > 0) {
    const first = result[0] as Record<string, unknown>;
    if (first && typeof first === 'object') {
      if ('changes' in first || 'lastInsertRowid' in first) {
        return {
          changes: Number(first.changes || 0),
          lastInsertRowid: Number(first.lastInsertRowid || 0),
        };
      }
      if ('affectedRows' in first || 'insertId' in first) {
        return {
          changes: Number(first.affectedRows || 0),
          lastInsertRowid: Number(first.insertId || 0),
        };
      }
      if ('rowCount' in first) {
        return {
          changes: Number(first.rowCount || 0),
          lastInsertRowid: 0,
        };
      }
    }
  }

  return { changes: 0, lastInsertRowid: 0 };
}

const wrappedObjects = new WeakMap<object, unknown>();

function shouldWrapObject(value: unknown): value is object {
  if (!value || typeof value !== 'object') return false;
  // Drizzle query builders are thenable objects (QueryPromise) but are not native Promises.
  // They still need wrapping so we can provide sqlite-style `.all/.get/.run` shims.
  if (value instanceof Promise) return false;
  return true;
}

function wrapQueryLike<T>(value: T): T {
  if (!shouldWrapObject(value)) return value;
  const target = value as unknown as object;
  if (wrappedObjects.has(target)) {
    return wrappedObjects.get(target) as T;
  }

  const proxy = new Proxy(target as Record<string, unknown>, {
    get(innerTarget, prop, receiver) {
      if (prop === 'then' && typeof innerTarget.then === 'function') {
        return innerTarget.then.bind(innerTarget);
      }

      if (prop === 'all' && typeof innerTarget.all !== 'function' && typeof innerTarget.execute === 'function') {
        return async (...args: unknown[]) => normalizeAllResult(await (innerTarget.execute as (...a: unknown[]) => Promise<unknown>)(...args));
      }

      if (prop === 'get' && typeof innerTarget.get !== 'function' && typeof innerTarget.execute === 'function') {
        return async (...args: unknown[]) => {
          const rows = normalizeAllResult(await (innerTarget.execute as (...a: unknown[]) => Promise<unknown>)(...args));
          return rows[0] ?? undefined;
        };
      }

      if (prop === 'run' && typeof innerTarget.run !== 'function' && typeof innerTarget.execute === 'function') {
        return async (...args: unknown[]) => normalizeRunResult(await (innerTarget.execute as (...a: unknown[]) => Promise<unknown>)(...args));
      }

      const original = Reflect.get(innerTarget, prop, receiver);
      if (typeof original !== 'function') {
        return original;
      }

      return (...args: unknown[]) => {
        const result = original.apply(innerTarget, args);
        if (shouldWrapObject(result)) {
          return wrapQueryLike(result);
        }
        return result;
      };
    },
  });

  wrappedObjects.set(target, proxy);
  return proxy as unknown as T;
}

function wrapDbClient<T extends object>(
  rawDb: T,
  customTransaction?: <R>(fn: (tx: any) => Promise<R> | R) => Promise<R>,
) {
  return new Proxy(rawDb as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        if (customTransaction) return customTransaction;

        const originalTransaction = target.transaction;
        if (typeof originalTransaction !== 'function') return undefined;
        return async <R>(fn: (tx: any) => Promise<R> | R) => {
          return await (originalTransaction as (handler: (tx: unknown) => Promise<R> | R) => Promise<R>).call(target, async (tx: unknown) => {
            return await fn(wrapDbClient(tx as object));
          });
        };
      }

      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') {
        return original;
      }

      return (...args: unknown[]) => {
        const result = original.apply(target, args);
        if (shouldWrapObject(result)) {
          return wrapQueryLike(result);
        }
        return result;
      };
    },
  }) as T;
}

function initSqliteDb() {
  const sqlitePath = resolveSqlitePath();
  if (sqlitePath !== ':memory:') {
    mkdirSync(dirname(sqlitePath), { recursive: true });
  }

  const sqlite = new Database(sqlitePath);
  sqliteConnection = sqlite;
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  ensureTokenManagementSchema();
  ensureSiteStatusSchema();
  ensureSiteProxySchema();
  ensureSiteExternalCheckinUrlSchema();
  ensureSiteGlobalWeightSchema();
  ensureRouteGroupingSchema();
  ensureDownstreamApiKeySchema();

  const rawDb = drizzleSqliteProxy(
    (sqlText, params, method) => sqliteProxyQuery(sqlText, params, method as SqlMethod),
    { schema },
  ) as any;
  return wrapDbClient(rawDb);
}

type AppDb = ReturnType<typeof initSqliteDb>;

function initMysqlDb(): AppDb {
  if (!config.dbUrl) {
    throw new Error('DB_URL is required when DB_TYPE=mysql');
  }
  mysqlPool = mysql.createPool(config.dbUrl);

  const rawDb = drizzleMysqlProxy(
    (sqlText, params, method) => mysqlProxyQuery(mysqlPool!, sqlText, params, method as SqlMethod),
    { schema },
  ) as any;

  return wrapDbClient(rawDb, async <R>(fn: (tx: any) => Promise<R> | R) => {
    const connection = await mysqlPool!.getConnection();
    try {
      await connection.beginTransaction();
      const txRaw = drizzleMysqlProxy(
        (sqlText, params, method) => mysqlProxyQuery(connection, sqlText, params, method as SqlMethod),
        { schema },
      ) as any;
      const txWrapped = wrapDbClient(txRaw);
      const result = await fn(txWrapped);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }) as AppDb;
}

function initPostgresDb(): AppDb {
  if (!config.dbUrl) {
    throw new Error('DB_URL is required when DB_TYPE=postgres');
  }
  pgPool = new pg.Pool({ connectionString: config.dbUrl });

  const rawDb = drizzlePgProxy(
    (sqlText, params, method) => pgProxyQuery(pgPool!, sqlText, params, method as SqlMethod),
    { schema },
  ) as any;

  return wrapDbClient(rawDb, async <R>(fn: (tx: any) => Promise<R> | R) => {
    const client = await pgPool!.connect();
    try {
      await client.query('BEGIN');
      const txRaw = drizzlePgProxy(
        (sqlText, params, method) => pgProxyQuery(client, sqlText, params, method as SqlMethod),
        { schema },
      ) as any;
      const txWrapped = wrapDbClient(txRaw);
      const result = await fn(txWrapped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }) as AppDb;
}

function initDb(): AppDb {
  if (runtimeDbDialect === 'mysql') return initMysqlDb();
  if (runtimeDbDialect === 'postgres') return initPostgresDb();
  return initSqliteDb();
}

let activeDb: AppDb = initDb();

export const db: any = new Proxy({}, {
  get(_target, prop) {
    return (activeDb as any)?.[prop as keyof typeof activeDb];
  },
});
export { schema };

export async function closeDbConnections(): Promise<void> {
  if (mysqlPool) {
    await mysqlPool.end();
    mysqlPool = null;
  }
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (sqliteConnection) {
    sqliteConnection.close();
    sqliteConnection = null;
  }
}

export async function switchRuntimeDatabase(nextDialect: RuntimeDbDialect, nextDbUrl: string): Promise<void> {
  const previousDialect = runtimeDbDialect;
  const previousDbUrl = config.dbUrl;
  const previousConfigDialect = config.dbType;

  await closeDbConnections();

  runtimeDbDialect = nextDialect;
  config.dbType = nextDialect;
  config.dbUrl = nextDbUrl;

  try {
    activeDb = initDb();
  } catch (error) {
    await closeDbConnections();
    runtimeDbDialect = previousDialect;
    config.dbType = previousConfigDialect;
    config.dbUrl = previousDbUrl;
    activeDb = initDb();
    throw error;
  }
}

export const __dbProxyTestUtils = {
  wrapQueryLike,
  shouldWrapObject,
};
