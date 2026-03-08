import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type MigrationJournalEntry = {
  tag: string;
  when: number;
};

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');

function readMigrationJournalEntries(): MigrationJournalEntry[] {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: MigrationJournalEntry[] };
  return journal.entries ?? [];
}

function applyMigrationSql(sqlite: Database.Database, sqlText: string) {
  const statements = sqlText
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    sqlite.exec(statement);
  }
}

describe('sqlite migrate bootstrap', () => {
  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.DB_URL;
    vi.resetModules();
  });

  it('accepts an already-synced sqlite schema with an empty drizzle journal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'metapi-migrate-'));
    const dbPath = join(dataDir, 'hub.db');
    const sqlite = new Database(dbPath);
    const journalEntries = readMigrationJournalEntries();

    for (const entry of journalEntries) {
      const sqlText = readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8');
      applyMigrationSql(sqlite, sqlText);
    }

    sqlite.close();

    process.env.DATA_DIR = dataDir;
    vi.resetModules();

    await expect(import('./migrate.js')).resolves.toMatchObject({
      runSqliteMigrations: expect.any(Function),
    });

    const verified = new Database(dbPath, { readonly: true });
    const appliedRows = verified
      .prepare('select created_at from __drizzle_migrations order by created_at asc')
      .all() as Array<{ created_at: number }>;

    expect(appliedRows.map((row) => Number(row.created_at))).toEqual(
      journalEntries.map((entry) => entry.when),
    );

    verified.close();
  });
});
