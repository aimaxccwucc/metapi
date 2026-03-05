import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type DbModule = typeof import('./index.js');

describe('db proxy query wrapper', () => {
  let testUtils: DbModule['__dbProxyTestUtils'];

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-db-proxy-wrap-'));
    const dbModule = await import('./index.js');
    testUtils = dbModule.__dbProxyTestUtils;
  });

  it('wraps thenable query builders and provides all/get shims', async () => {
    const execute = vi.fn(async () => [{ id: 1, name: 'demo' }]);
    const queryLike = {
      execute,
      where() {
        return this;
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(execute()).then(onFulfilled, onRejected);
      },
    };

    expect(testUtils.shouldWrapObject(queryLike)).toBe(true);
    const wrapped = testUtils.wrapQueryLike(queryLike as any);

    const rows = await wrapped.where().all();
    const row = await wrapped.where().get();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(rows).toEqual([{ id: 1, name: 'demo' }]);
    expect(row).toEqual({ id: 1, name: 'demo' });
  });

  it('provides run shim for thenable query builders', async () => {
    const execute = vi.fn(async () => [{ changes: 3, lastInsertRowid: 9 }]);
    const queryLike = {
      execute,
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(execute()).then(onFulfilled, onRejected);
      },
    };

    const wrapped = testUtils.wrapQueryLike(queryLike as any);
    const runResult = await wrapped.run();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(runResult).toEqual({ changes: 3, lastInsertRowid: 9 });
    expect(testUtils.shouldWrapObject(Promise.resolve())).toBe(false);
  });
});

