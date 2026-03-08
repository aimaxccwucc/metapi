import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type MigrationJournalEntry = {
  tag: string;
  when: number;
};

type MigrationJournalFile = {
  entries?: MigrationJournalEntry[];
};

type SchemaMarker = {
  table: string;
  column?: string;
};

type MigrationRecord = {
  createdAt: number;
  hash: string;
};

const VERIFIED_BOOTSTRAP_TAG = '0004_sorting_preferences';
const VERIFIED_SCHEMA_MARKERS: SchemaMarker[] = [
  { table: 'sites' },
  { table: 'settings' },
  { table: 'accounts' },
  { table: 'checkin_logs' },
  { table: 'model_availability' },
  { table: 'proxy_logs' },
  { table: 'token_routes' },
  { table: 'route_channels', column: 'token_id' },
  { table: 'account_tokens' },
  { table: 'token_model_availability' },
  { table: 'events' },
  { table: 'sites', column: 'is_pinned' },
  { table: 'sites', column: 'sort_order' },
  { table: 'accounts', column: 'is_pinned' },
  { table: 'accounts', column: 'sort_order' },
];

function resolveSqliteDbPath(): string {
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

function resolveMigrationsFolder(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  const row = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table);
  return !!row;
}

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  if (!tableExists(sqlite, table)) return false;
  const rows = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === column);
}

function hasRecordedDrizzleMigrations(sqlite: Database.Database): boolean {
  if (!tableExists(sqlite, '__drizzle_migrations')) return false;
  const row = sqlite.prepare('SELECT 1 FROM __drizzle_migrations LIMIT 1').get();
  return !!row;
}

function hasVerifiedLegacySchema(sqlite: Database.Database): boolean {
  return VERIFIED_SCHEMA_MARKERS.every((marker) => (
    marker.column
      ? columnExists(sqlite, marker.table, marker.column)
      : tableExists(sqlite, marker.table)
  ));
}

function readVerifiedMigrationRecords(migrationsFolder: string): MigrationRecord[] {
  const journalPath = resolve(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as MigrationJournalFile;
  const records: MigrationRecord[] = [];

  for (const entry of journal.entries ?? []) {
    const migrationSql = readFileSync(resolve(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    records.push({
      createdAt: Number(entry.when),
      hash: createHash('sha256').update(migrationSql).digest('hex'),
    });

    if (entry.tag === VERIFIED_BOOTSTRAP_TAG) {
      return records;
    }
  }

  return [];
}

function bootstrapLegacyDrizzleMigrations(sqlite: Database.Database, migrationsFolder: string): boolean {
  if (hasRecordedDrizzleMigrations(sqlite)) return false;
  if (!hasVerifiedLegacySchema(sqlite)) return false;

  const records = readVerifiedMigrationRecords(migrationsFolder);
  if (records.length === 0) return false;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);

  const insert = sqlite.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)');
  const applyBootstrap = sqlite.transaction((migrations: MigrationRecord[]) => {
    for (const migrationRecord of migrations) {
      insert.run(migrationRecord.hash, migrationRecord.createdAt);
    }
  });

  applyBootstrap(records);
  console.log('[db] Bootstrapped drizzle migration journal for existing SQLite schema.');
  return true;
}

export function runSqliteMigrations(): void {
  const dbPath = resolveSqliteDbPath();
  const migrationsFolder = resolveMigrationsFolder();
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const sqlite = new Database(dbPath);
  bootstrapLegacyDrizzleMigrations(sqlite, migrationsFolder);
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder });
  sqlite.close();
  console.log('Migration complete.');
}

runSqliteMigrations();
