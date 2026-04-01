import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';

type DbModule = typeof import('./index.js');

describe('sqlite default path resolution', () => {
  let dbModule: DbModule | null = null;
  let mysqlMockState: {
    columns: Array<Record<string, string>>;
  } | null = null;

  afterEach(async () => {
    if (dbModule) {
      await dbModule.closeDbConnections();
      dbModule = null;
    }
    mysqlMockState = null;
    delete process.env.DATA_DIR;
    delete process.env.DB_URL;
    delete process.env.DB_TYPE;
    vi.resetModules();
    vi.doUnmock('mysql2/promise');
  });

  it('uses an isolated temp sqlite path under vitest when no db env is configured', async () => {
    delete process.env.DATA_DIR;
    delete process.env.DB_URL;
    vi.resetModules();

    dbModule = await import('./index.js');
    const sqlitePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();
    const sharedRepoPath = resolve('./data/hub.db');

    expect(sqlitePath).not.toBe(sharedRepoPath);
    expect(sqlitePath).toContain(tmpdir());
    expect(sqlitePath).toContain('metapi-vitest');
  });

  it('still honors explicit DATA_DIR when provided', async () => {
    process.env.DATA_DIR = resolve(tmpdir(), 'metapi-explicit-data-dir');
    delete process.env.DB_URL;
    vi.resetModules();

    dbModule = await import('./index.js');
    const sqlitePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();

    expect(sqlitePath).toBe(resolve(process.env.DATA_DIR, 'hub.db'));
  });

  it('ignores the default repo DATA_DIR under vitest and still isolates sqlite', async () => {
    process.env.DATA_DIR = './data';
    delete process.env.DB_URL;
    vi.resetModules();

    dbModule = await import('./index.js');
    const sqlitePath = dbModule.__dbProxyTestUtils.resolveSqlitePath();
    const sharedRepoPath = resolve('./data/hub.db');

    expect(sqlitePath).not.toBe(sharedRepoPath);
    expect(sqlitePath).toContain(tmpdir());
    expect(sqlitePath).toContain('metapi-vitest');
  });

  it('accepts mysql information_schema rows with uppercase COLUMN_NAME fields', async () => {
    process.env.DB_TYPE = 'mysql';
    process.env.DB_URL = 'mysql://user:pass@127.0.0.1:3306/metapi';
    const tempDataDir = mkdtempSync(join(tmpdir(), 'metapi-mysql-schema-'));
    process.env.DATA_DIR = tempDataDir;
    mysqlMockState = {
      columns: [
        { COLUMN_NAME: 'cache_key' },
        { COLUMN_NAME: 'model' },
        { COLUMN_NAME: 'response_body' },
        { COLUMN_NAME: 'is_stream' },
        { COLUMN_NAME: 'prompt_tokens' },
        { COLUMN_NAME: 'completion_tokens' },
        { COLUMN_NAME: 'estimated_cost' },
        { COLUMN_NAME: 'hit_count' },
        { COLUMN_NAME: 'created_at' },
        { COLUMN_NAME: 'expires_at' },
      ],
    };

    vi.doMock('mysql2/promise', () => {
      const createPool = vi.fn(() => ({
        query: vi.fn(async (sqlText: string) => {
          if (sqlText.includes('FROM information_schema.columns')) {
            return [mysqlMockState?.columns ?? [], undefined];
          }
          throw new Error(`Unexpected query: ${sqlText}`);
        }),
        getConnection: vi.fn(async () => ({
          beginTransaction: vi.fn(),
          commit: vi.fn(),
          rollback: vi.fn(),
          release: vi.fn(),
          query: vi.fn(),
        })),
        end: vi.fn(async () => undefined),
      }));
      return {
        default: { createPool },
        createPool,
      };
    });

    vi.resetModules();
    dbModule = await import('./index.js');

    await expect(dbModule.hasResponseCacheTable()).resolves.toBe(true);
  });
});
