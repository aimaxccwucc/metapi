import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type BackupServiceModule = typeof import('./backupService.js');

describe('backupService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let backupService: BackupServiceModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-backup-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./backupService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    backupService = serviceModule;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('preserves extended fields in full backup import/export roundtrip', async () => {
    const now = new Date().toISOString();
    const site = await db.insert(schema.sites).values({
      name: 'roundtrip-site',
      url: 'https://roundtrip.example.com',
      platform: 'new-api',
      externalCheckinUrl: 'https://checkin.roundtrip.example.com',
      proxyUrl: 'http://127.0.0.1:8080',
      useSystemProxy: true,
      customHeaders: JSON.stringify({
        'cf-access-client-id': 'roundtrip-client',
      }),
      status: 'active',
      isPinned: true,
      sortOrder: 9,
      apiKey: 'site-api-key',
      createdAt: now,
      updatedAt: now,
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'roundtrip-user',
      accessToken: 'session-token',
      apiToken: 'api-token',
      balance: 12.3,
      balanceUsed: 4.5,
      quota: 99.9,
      unitCost: 0.2,
      valueScore: 1.1,
      status: 'active',
      isPinned: true,
      sortOrder: 7,
      checkinEnabled: true,
      extraConfig: JSON.stringify({ platformUserId: 123 }),
      createdAt: now,
      updatedAt: now,
    }).returning().get();

    const accountToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-roundtrip-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      displayName: 'gpt-route',
      displayIcon: 'icon-gpt',
      modelMapping: JSON.stringify({ to: 'gpt-4o-mini' }),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: accountToken.id,
      sourceModel: 'gpt-4o',
      priority: 3,
      weight: 5,
      enabled: true,
      manualOverride: false,
      successCount: 10,
      failCount: 1,
      totalLatencyMs: 2500,
      totalCost: 2.5,
      lastUsedAt: now,
      lastFailAt: now,
      cooldownUntil: now,
    }).run();

    const exported = await backupService.exportBackup('all');
    const result = await backupService.importBackup(exported as unknown as Record<string, unknown>);

    expect(result.allImported).toBe(true);
    expect(result.sections.accounts).toBe(true);

    const restoredSite = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
    const restoredAccount = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    const restoredRoute = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, route.id)).get();
    const restoredChannel = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.routeId, route.id)).get();

    expect(restoredSite?.proxyUrl).toBe('http://127.0.0.1:8080');
    expect(restoredSite?.externalCheckinUrl).toBe('https://checkin.roundtrip.example.com');
    expect(restoredSite?.useSystemProxy).toBe(true);
    expect(restoredSite?.customHeaders).toBe('{"cf-access-client-id":"roundtrip-client"}');
    expect(restoredSite?.isPinned).toBe(true);
    expect(restoredSite?.sortOrder).toBe(9);

    expect(restoredAccount?.isPinned).toBe(true);
    expect(restoredAccount?.sortOrder).toBe(7);

    expect(restoredRoute?.displayName).toBe('gpt-route');
    expect(restoredRoute?.displayIcon).toBe('icon-gpt');

    expect(restoredChannel?.sourceModel).toBe('gpt-4o');
  });

  it('imports ALL-API-Hub style payload with accounts and preferences', async () => {
    const payload = {
      timestamp: Date.now(),
      accounts: {
        accounts: [
          {
            site_url: 'https://legacy.example.com',
            site_type: 'new-api',
            site_name: 'legacy-site',
            username: 'legacy-user',
            authType: 'session',
            account_info: {
              id: 7788,
              username: 'legacy-user',
              access_token: 'legacy-session-token',
              quota: 100000,
              today_quota_consumption: 50000,
            },
            checkIn: {
              autoCheckInEnabled: true,
            },
            created_at: '2026-02-01T00:00:00.000Z',
            updated_at: '2026-02-02T00:00:00.000Z',
          },
        ],
      },
      preferences: {
        locale: 'zh-CN',
      },
      channelConfigs: {
        order: ['a', 'b'],
      },
      apiCredentialProfiles: {
        default: 'main',
      },
      tagStore: {
        groups: ['test'],
      },
    } as Record<string, unknown>;

    const result = await backupService.importBackup(payload);
    expect(result.allImported).toBe(true);
    expect(result.sections.accounts).toBe(true);
    expect(result.sections.preferences).toBe(true);
    expect(result.appliedSettings.length).toBeGreaterThan(0);

    const sites = await db.select().from(schema.sites).all();
    const accounts = await db.select().from(schema.accounts).all();
    const settings = await db.select().from(schema.settings).all();

    expect(sites.length).toBe(1);
    expect(accounts.length).toBe(1);
    expect(accounts[0].username).toBe('legacy-user');
    expect(settings.some((row) => row.key === 'legacy_preferences_ref_v2')).toBe(true);
  });

  it('merges ALL-API-Hub accounts without overwriting existing data', async () => {
    const existingSite = db.insert(schema.sites).values({
      name: 'existing-site',
      url: 'https://same.example.com',
      platform: 'new-api',
      status: 'active',
      isPinned: false,
      sortOrder: 0,
      globalWeight: 1,
    }).returning().get();

    const existingAccount = db.insert(schema.accounts).values({
      siteId: existingSite.id,
      username: 'alice',
      accessToken: 'sess-old',
      apiToken: null,
      balance: 0,
      balanceUsed: 0,
      quota: 0,
      unitCost: null,
      valueScore: 0,
      status: 'active',
      isPinned: false,
      sortOrder: 0,
      checkinEnabled: true,
      extraConfig: JSON.stringify({ platformUserId: 1001 }),
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }).returning().get();

    const payload = {
      timestamp: Date.now(),
      accounts: {
        accounts: [
          {
            site_url: 'https://same.example.com/path?a=1',
            site_type: 'new-api',
            site_name: 'same-site-imported',
            authType: 'api_key',
            account_info: {
              id: 1001,
              username: 'alice',
              access_token: 'sk-new-primary',
              quota: 200000,
              today_quota_consumption: 100000,
              api_key: 'sk-new-primary',
            },
            apiTokens: [
              { key: 'sk-new-primary' },
              { key: 'sk-new-secondary' },
            ],
            checkIn: {
              autoCheckInEnabled: false,
            },
            created_at: '2030-01-01T00:00:00.000Z',
            updated_at: '2030-01-02T00:00:00.000Z',
          },
          {
            site_url: 'https://new.example.com',
            site_type: 'one-api',
            site_name: 'new-site',
            authType: 'access_token',
            account_info: {
              id: 2002,
              username: 'bob',
              access_token: 'sess-bob',
              quota: 50000,
              today_quota_consumption: 5000,
            },
            checkIn: {
              autoCheckInEnabled: true,
              customCheckIn: {
                url: 'https://new.example.com/welfare',
              },
            },
            created_at: '2030-02-01T00:00:00.000Z',
            updated_at: '2030-02-02T00:00:00.000Z',
          },
          {
            site_url: '',
            site_type: 'new-api',
            account_info: {
              id: 3003,
              username: 'skip-me',
              access_token: 'sess-skip',
            },
          },
        ],
      },
    } as Record<string, unknown>;

    const result = await backupService.importAllApiHubAccountsMerge(payload);

    expect(result.importedRows).toBe(2);
    expect(result.skippedRows).toBe(1);
    expect(result.sites.created).toBe(1);
    expect(result.accounts.created).toBe(1);
    expect(result.accounts.updated).toBe(1);
    expect(result.tokens.created).toBe(2);
    expect(result.repairedDefaultTokenAccounts).toBe(1);

    const allSites = db.select().from(schema.sites).all();
    const allAccounts = db.select().from(schema.accounts).all();
    const allTokens = db.select().from(schema.accountTokens).all();

    expect(allSites.length).toBe(2);
    expect(allAccounts.length).toBe(2);
    expect(allTokens.length).toBe(2);
    const importedNewSite = allSites.find((site) => site.url === 'https://new.example.com');
    expect(importedNewSite?.externalCheckinUrl).toBe('https://new.example.com/welfare');

    const updatedAccount = db.select().from(schema.accounts).where(eq(schema.accounts.id, existingAccount.id)).get();
    expect(updatedAccount).toBeTruthy();
    expect(updatedAccount?.balance).toBeCloseTo(0.4, 6);
    expect(updatedAccount?.balanceUsed).toBeCloseTo(0.2, 6);
    expect(updatedAccount?.checkinEnabled).toBe(false);
    expect(updatedAccount?.apiToken).toBe('sk-new-primary');

    const updatedExtraConfig = JSON.parse(updatedAccount?.extraConfig || '{}') as Record<string, unknown>;
    expect(updatedExtraConfig.credentialMode).toBe('apikey');

    const defaultTokens = allTokens.filter((token) => token.accountId === existingAccount.id && token.isDefault);
    expect(defaultTokens.length).toBe(1);
  });

  it('fills existing site external checkin url from import data when empty', async () => {
    const existingSite = db.insert(schema.sites).values({
      name: 'existing',
      url: 'https://welfare-fill.example.com',
      platform: 'new-api',
      externalCheckinUrl: null,
      status: 'active',
      isPinned: false,
      sortOrder: 0,
      globalWeight: 1,
    }).returning().get();

    db.insert(schema.accounts).values({
      siteId: existingSite.id,
      username: 'user',
      accessToken: 'old-token',
      apiToken: null,
      balance: 0,
      balanceUsed: 0,
      quota: 0,
      status: 'active',
      isPinned: false,
      sortOrder: 0,
      checkinEnabled: true,
      extraConfig: JSON.stringify({ platformUserId: 777 }),
    }).run();

    const payload = {
      timestamp: Date.now(),
      accounts: {
        accounts: [
          {
            site_url: 'https://welfare-fill.example.com',
            site_type: 'new-api',
            site_name: 'existing',
            authType: 'access_token',
            account_info: {
              id: 777,
              username: 'user',
              access_token: 'new-token',
              quota: 10_000,
            },
            checkIn: {
              customCheckIn: {
                url: 'https://welfare-fill.example.com/checkin',
              },
            },
          },
        ],
      },
    } as Record<string, unknown>;

    const result = await backupService.importAllApiHubAccountsMerge(payload);
    expect(result.importedRows).toBe(1);

    const refreshed = db.select().from(schema.sites).where(eq(schema.sites.id, existingSite.id)).get();
    expect(refreshed?.externalCheckinUrl).toBe('https://welfare-fill.example.com/checkin');
  });
});
