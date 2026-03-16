import { afterEach, describe, expect, it, vi } from 'vitest';

describe('upsertSetting', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('./index.js');
  });

  it('updates existing values through the mysql compatibility path', async () => {
    const targetKey = 'mysql_upsert_setting_test';
    const store = new Map<string, string>([[targetKey, JSON.stringify({ before: true })]]);

    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            get: async () => {
              const value = store.get(targetKey);
              return value ? { key: targetKey, value } : undefined;
            },
          }),
        }),
      }),
      update: () => ({
        set: ({ value }: { value: string }) => ({
          where: () => ({
            run: async () => {
              store.set(targetKey, value);
            },
          }),
        }),
      }),
      insert: () => ({
        values: ({ key, value }: { key: string; value: string }) => ({
          run: async () => {
            store.set(key, value);
          },
        }),
      }),
    };

    vi.doMock('./index.js', () => ({
      db: fakeDb,
      runtimeDbDialect: 'mysql',
      schema: { settings: { key: 'key' } },
    }));

    const { upsertSetting } = await import('./upsertSetting.js');
    await upsertSetting(targetKey, { after: true });

    expect(store.get(targetKey)).toBe(JSON.stringify({ after: true }));
  });

  it('inserts missing values through the mysql compatibility path', async () => {
    const targetKey = 'mysql_upsert_setting_insert_test';
    const store = new Map<string, string>();

    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            get: async () => undefined,
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            run: async () => {
              throw new Error('update should not be called when setting is missing');
            },
          }),
        }),
      }),
      insert: () => ({
        values: ({ key, value }: { key: string; value: string }) => ({
          run: async () => {
            store.set(key, value);
          },
        }),
      }),
    };

    vi.doMock('./index.js', () => ({
      db: fakeDb,
      runtimeDbDialect: 'mysql',
      schema: { settings: { key: 'key' } },
    }));

    const { upsertSetting } = await import('./upsertSetting.js');
    await upsertSetting(targetKey, { created: true });

    expect(store.get(targetKey)).toBe(JSON.stringify({ created: true }));
  });
});
