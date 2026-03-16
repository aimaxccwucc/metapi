import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

const undiciFetchMock = vi.fn();
const getApiTokensMock = vi.fn();
const getApiTokenMock = vi.fn();
const createApiTokenMock = vi.fn();
const getUserGroupsMock = vi.fn();

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    createApiToken: (...args: unknown[]) => createApiTokenMock(...args),
    getUserGroups: (...args: unknown[]) => getUserGroupsMock(...args),
  }),
}));

type DbModule = typeof import('../db/index.js');
type AccountKeyRepairModule = typeof import('./accountKeyRepairService.js');

describe('accountKeyRepairService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let repairService: AccountKeyRepairModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-key-repair-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./accountKeyRepairService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    repairService = serviceModule;
  });

  beforeEach(async () => {
    undiciFetchMock.mockReset();
    getApiTokensMock.mockReset();
    getApiTokenMock.mockReset();
    createApiTokenMock.mockReset();
    getUserGroupsMock.mockReset();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('creates default token from account.apiToken when account has no token rows', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Site A',
      url: 'https://a.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'session-a',
      apiToken: 'sk-alice-default',
      status: 'active',
      checkinEnabled: true,
    }).returning().get();

    const result = await repairService.repairAllAccountKeys();
    expect(result.summary.total).toBe(1);
    expect(result.summary.created).toBe(1);
    expect(result.summary.failed).toBe(0);

    const row = result.results[0];
    expect(row?.accountId).toBe(account.id);
    expect(row?.status).toBe('created');

    const tokens = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, account.id)).all();
    expect(tokens.length).toBe(1);
    expect(tokens[0]?.token).toBe('sk-alice-default');
    expect(tokens[0]?.isDefault).toBe(true);
    expect(tokens[0]?.enabled).toBe(true);
  });

  it('repairs missing default flag when enabled tokens exist', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Site B',
      url: 'https://b.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'bob',
      accessToken: 'session-b',
      apiToken: '',
      status: 'active',
      checkinEnabled: true,
    }).returning().get();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'imported',
      token: 'sk-bob-1',
      enabled: true,
      isDefault: false,
      source: 'manual',
    }).run();

    const result = await repairService.repairAllAccountKeys();
    expect(result.summary.repaired).toBe(1);
    expect(result.summary.failed).toBe(0);

    const tokens = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, account.id)).all();
    expect(tokens.length).toBe(1);
    expect(tokens[0]?.isDefault).toBe(true);
  });

  it('skips disabled sites and disabled accounts', async () => {
    const disabledSite = await db.insert(schema.sites).values({
      name: 'Disabled Site',
      url: 'https://disabled-site.example.com',
      platform: 'new-api',
      status: 'disabled',
    }).returning().get();

    const activeSite = await db.insert(schema.sites).values({
      name: 'Active Site',
      url: 'https://active-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.accounts).values({
      siteId: disabledSite.id,
      username: 'site-disabled',
      accessToken: 'sess-1',
      apiToken: '',
      status: 'active',
    }).run();

    await db.insert(schema.accounts).values({
      siteId: activeSite.id,
      username: 'account-disabled',
      accessToken: 'sess-2',
      apiToken: '',
      status: 'disabled',
    }).run();

    const result = await repairService.repairAllAccountKeys();
    expect(result.summary.total).toBe(2);
    expect(result.summary.skipped).toBe(2);
    expect(result.summary.failed).toBe(0);
    expect(result.results.every((item) => item.status === 'skipped')).toBe(true);
  });

  it('creates upstream default token with the lowest-ratio available group', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Site C',
      url: 'https://c.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'carol',
      accessToken: 'session-c',
      apiToken: '',
      status: 'active',
      checkinEnabled: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      { accountId: account.id, modelName: 'gpt-4o', available: true, checkedAt: new Date().toISOString() },
    ]).run();

    getApiTokensMock.mockResolvedValue([]);
    getApiTokenMock.mockResolvedValue(null);
    getUserGroupsMock.mockResolvedValue(['default', 'vip']);
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    getApiTokenMock.mockResolvedValueOnce(null).mockResolvedValueOnce('sk-carol-created');

    undiciFetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [
        {
          model_name: 'gpt-4o',
          quota_type: 0,
          model_ratio: 1,
          completion_ratio: 1,
          model_price: null,
          enable_groups: ['default', 'vip'],
        },
      ],
      group_ratio: { default: 10, vip: 1 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }) as any);

    const result = await repairService.repairAllAccountKeys();
    expect(result.summary.failed).toBe(0);
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(createApiTokenMock.mock.calls[0][3]).toMatchObject({
      name: 'metapi-default',
      group: 'vip',
    });
  });
});
