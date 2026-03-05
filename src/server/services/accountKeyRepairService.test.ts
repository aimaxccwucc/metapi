import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

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

  beforeEach(() => {
    db.delete(schema.routeChannels).run();
    db.delete(schema.tokenRoutes).run();
    db.delete(schema.tokenModelAvailability).run();
    db.delete(schema.modelAvailability).run();
    db.delete(schema.proxyLogs).run();
    db.delete(schema.checkinLogs).run();
    db.delete(schema.accountTokens).run();
    db.delete(schema.accounts).run();
    db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('creates default token from account.apiToken when account has no token rows', async () => {
    const site = db.insert(schema.sites).values({
      name: 'Site A',
      url: 'https://a.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = db.insert(schema.accounts).values({
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

    const tokens = db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, account.id)).all();
    expect(tokens.length).toBe(1);
    expect(tokens[0]?.token).toBe('sk-alice-default');
    expect(tokens[0]?.isDefault).toBe(true);
    expect(tokens[0]?.enabled).toBe(true);
  });

  it('repairs missing default flag when enabled tokens exist', async () => {
    const site = db.insert(schema.sites).values({
      name: 'Site B',
      url: 'https://b.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'bob',
      accessToken: 'session-b',
      apiToken: '',
      status: 'active',
      checkinEnabled: true,
    }).returning().get();

    db.insert(schema.accountTokens).values({
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

    const tokens = db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, account.id)).all();
    expect(tokens.length).toBe(1);
    expect(tokens[0]?.isDefault).toBe(true);
  });

  it('skips disabled sites and disabled accounts', async () => {
    const disabledSite = db.insert(schema.sites).values({
      name: 'Disabled Site',
      url: 'https://disabled-site.example.com',
      platform: 'new-api',
      status: 'disabled',
    }).returning().get();

    const activeSite = db.insert(schema.sites).values({
      name: 'Active Site',
      url: 'https://active-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    db.insert(schema.accounts).values({
      siteId: disabledSite.id,
      username: 'site-disabled',
      accessToken: 'sess-1',
      apiToken: '',
      status: 'active',
    }).run();

    db.insert(schema.accounts).values({
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
});
