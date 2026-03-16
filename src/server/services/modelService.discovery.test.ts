import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const getApiTokenMock = vi.fn();
const getModelsMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('refreshModelsForAccount credential discovery', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let refreshModelsForAccount: ModelServiceModule['refreshModelsForAccount'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-discovery-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    refreshModelsForAccount = modelService.refreshModelsForAccount;
  });

  beforeEach(async () => {
    getApiTokenMock.mockReset();
    getModelsMock.mockReset();

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('discovers models from account session credential without account_tokens', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => (
      token === 'session-token' ? ['claude-sonnet-4-5-20250929', 'claude-opus-4-6'] : []
    ));

    const site = await db.insert(schema.sites).values({
      name: 'site-a',
      url: 'https://site-a.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      errorCode: null,
      errorMessage: '',
      modelCount: 2,
      modelsPreview: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6'],
      tokenScanned: 0,
      discoveredByCredential: true,
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(rows.map((row) => row.modelName).sort()).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-5-20250929',
    ]);

    const tokenRows = await db.select().from(schema.tokenModelAvailability).all();
    expect(tokenRows).toHaveLength(0);
  });

  it('serializes concurrent refreshes for the same account', async () => {
    getApiTokenMock.mockResolvedValue(null);
    let started = 0;
    let releaseDiscovery = null as null | (() => void);
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => {
      started += 1;
      if (token !== 'session-token') return [];
      await discoveryGate;
      return ['gpt-4o-mini'];
    });

    const site = await db.insert(schema.sites).values({
      name: 'site-concurrent',
      url: 'https://site-concurrent.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'concurrent-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const firstRefresh = refreshModelsForAccount(account.id);
    const secondRefresh = refreshModelsForAccount(account.id);

    await vi.waitFor(() => {
      expect(started).toBe(1);
    });
    releaseDiscovery?.();

    const [firstResult, secondResult] = await Promise.all([firstRefresh, secondRefresh]);

    expect(firstResult.status).toBe('success');
    expect(secondResult.status).toBe('success');
    expect(getModelsMock).toHaveBeenCalledTimes(2);

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.modelName).toBe('gpt-4o-mini');
  });

  it('dedupes account model names case-insensitively across credentials', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => {
      if (token === 'account-token') return ['GLM-4.6', 'Embedding-3'];
      if (token === 'managed-token') return ['glm-4.6', 'embedding-3'];
      return [];
    });

    const site = await db.insert(schema.sites).values({
      name: 'site-case-dedupe',
      url: 'https://site-case-dedupe.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'case-user',
      accessToken: '',
      apiToken: 'account-token',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'managed',
      token: 'managed-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).run();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      modelCount: 2,
      tokenScanned: 1,
      discoveredByCredential: true,
    });
    expect(result.modelsPreview).toEqual(['GLM-4.6', 'Embedding-3']);

    const accountRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(accountRows.map((row) => row.modelName).sort()).toEqual(['Embedding-3', 'GLM-4.6']);

    const tokenRows = await db.select().from(schema.tokenModelAvailability).all();
    expect(tokenRows.map((row) => row.modelName).sort()).toEqual(['embedding-3', 'glm-4.6']);
  });

  it('marks runtime health unhealthy when model discovery fails', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error('HTTP 401: invalid token'));

    const site = await db.insert(schema.sites).values({
      name: 'site-fail',
      url: 'https://site-fail.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fail-user',
      accessToken: '',
      apiToken: 'sk-invalid',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      modelCount: 0,
      modelsPreview: [],
      tokenScanned: 0,
      status: 'failed',
      errorCode: 'unauthorized',
    });

    const latest = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    const parsed = JSON.parse(latest!.extraConfig || '{}');
    expect(parsed.runtimeHealth?.state).toBe('unhealthy');
    expect(parsed.runtimeHealth?.source).toBe('model-discovery');
    expect(parsed.runtimeHealth?.reason).toBe('模型获取失败，API Key 已无效');
    expect(parsed.runtimeHealth?.checkedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('returns structured result when account missing', async () => {
    const result = await refreshModelsForAccount(9999);

    expect(result).toMatchObject({
      accountId: 9999,
      refreshed: false,
      status: 'failed',
      errorCode: 'account_not_found',
      errorMessage: '账号不存在',
      modelCount: 0,
      modelsPreview: [],
      reason: 'account_not_found',
    });
  });

  it('returns structured result when site disabled', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-disabled',
      url: 'https://site-disabled.example.com',
      platform: 'new-api',
      status: 'disabled',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'disabled-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: false,
      status: 'skipped',
      errorCode: 'site_disabled',
      errorMessage: '站点已禁用',
      modelCount: 0,
      modelsPreview: [],
      reason: 'site_disabled',
    });
  });

  it('returns structured result when account inactive', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-inactive',
      url: 'https://site-inactive.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'inactive-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'disabled',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: false,
      status: 'skipped',
      errorCode: 'adapter_or_status',
      errorMessage: '平台不可用或账号未激活',
      modelCount: 0,
      modelsPreview: [],
      reason: 'adapter_or_status',
    });
  });
});
