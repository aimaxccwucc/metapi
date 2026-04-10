import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getApiTokensMock = vi.fn();
const getApiTokenMock = vi.fn();
const createApiTokenMock = vi.fn();
const deleteApiTokenMock = vi.fn();
const getUserGroupsMock = vi.fn();
const getModelsMock = vi.fn();
const fetchModelPricingCatalogMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    createApiToken: (...args: unknown[]) => createApiTokenMock(...args),
    deleteApiToken: (...args: unknown[]) => deleteApiTokenMock(...args),
    getUserGroups: (...args: unknown[]) => getUserGroupsMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

vi.mock('../../services/modelPricingService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/modelPricingService.js')>('../../services/modelPricingService.js');
  return {
    ...actual,
    fetchModelPricingCatalog: (...args: unknown[]) => fetchModelPricingCatalogMock(...args),
  };
});

vi.mock('../../services/modelService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/modelService.js')>('../../services/modelService.js');
  return {
    ...actual,
    refreshModelsForAccount: async (accountId: number) => {
      const [{ db, schema }, { resolvePlatformUserId }] = await Promise.all([
        import('../../db/index.js'),
        import('../../services/accountExtraConfig.js'),
      ]);

      const row = await db.select()
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (!row) {
        return {
          accountId,
          success: false,
          errorCode: 'account_not_found',
          errorMessage: 'account not found',
          modelCount: 0,
          modelsPreview: [],
          tokenScanned: 0,
          discoveredByCredential: false,
          discoveredApiToken: false,
        };
      }

      const platformUserId = resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username);
      const tokens = (await db.select()
        .from(schema.accountTokens)
        .where(eq(schema.accountTokens.accountId, accountId))
        .all())
        .filter((token: AccountTokenRow) => token.enabled && !!token.token);

      for (const token of tokens) {
        await db.delete(schema.tokenModelAvailability)
          .where(eq(schema.tokenModelAvailability.tokenId, token.id))
          .run();

        const models = await getModelsMock(row.sites.url, token.token, platformUserId);
        const normalizedModels = Array.isArray(models)
          ? models.map((item) => String(item || '').trim()).filter(Boolean)
          : [];
        if (normalizedModels.length === 0) continue;

        await db.insert(schema.tokenModelAvailability).values(
          normalizedModels.map((modelName) => ({
            tokenId: token.id,
            modelName,
            available: true,
          })),
        ).run();
      }

      return {
        accountId,
        success: true,
        modelCount: 0,
        modelsPreview: [],
        tokenScanned: tokens.length,
        discoveredByCredential: false,
        discoveredApiToken: false,
      };
    },
  };
});

type DbModule = typeof import('../../db/index.js');
type AccountTokenRow = DbModule['schema']['accountTokens']['$inferSelect'];
type RouteGroupSourceRow = DbModule['schema']['routeGroupSources']['$inferSelect'];

describe('POST /api/routes auto token coverage', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-autocreate-coverage-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    getApiTokensMock.mockReset();
    getApiTokenMock.mockReset();
    createApiTokenMock.mockReset();
    deleteApiTokenMock.mockReset();
    getUserGroupsMock.mockReset();
    getModelsMock.mockReset();
    fetchModelPricingCatalogMock.mockReset();

    getApiTokensMock.mockResolvedValue([]);
    getApiTokenMock.mockResolvedValue(null);
    createApiTokenMock.mockResolvedValue(false);
    deleteApiTokenMock.mockResolvedValue(true);
    getUserGroupsMock.mockResolvedValue(['default']);
    getModelsMock.mockResolvedValue([]);
    fetchModelPricingCatalogMock.mockResolvedValue(null);

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('auto-creates token in lowest-ratio group when exact route has no token coverage', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'group-ratio-site',
      url: 'https://group-ratio-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'group-ratio-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'kimi-k2.5',
      available: true,
    }).run();

    getUserGroupsMock.mockResolvedValue(['default', 'vip']);
    fetchModelPricingCatalogMock.mockResolvedValue({
      groupRatio: { default: 1, vip: 0.25 },
      models: [{
        modelName: 'kimi-k2.5',
        quotaType: 0,
        modelDescription: null,
        tags: [],
        supportedEndpointTypes: [],
        ownerBy: null,
        enableGroups: ['default', 'vip'],
        groupPricing: {},
      }],
    });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'metapi-vip-shared', key: 'sk-vip-created', enabled: true, tokenGroup: 'vip' },
    ]);
    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (credential === 'sk-vip-created') return ['kimi-k2.5'];
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'kimi-k2.5',
        enabled: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(createApiTokenMock.mock.calls[0]?.[3]).toMatchObject({ group: 'vip' });

    const tokens = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    const createdToken = tokens.find((item: AccountTokenRow) => item.token === 'sk-vip-created');
    expect(createdToken?.tokenGroup).toBe('vip');

    const route = response.json() as { id: number };
    const channels = await db.select()
      .from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, route.id))
      .all();
    expect(channels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: account.id,
        tokenId: createdToken?.id,
        sourceModel: 'kimi-k2.5',
      }),
    ]));
  });

  it('returns without hanging when token auto-provisioning exceeds soft timeout', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'slow-site',
      url: 'https://slow-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'slow-user',
      accessToken: 'slow-session',
      apiToken: null,
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'slow-model',
      available: true,
    }).run();

    getUserGroupsMock.mockImplementation(() => new Promise<string[]>(() => {}));

    const startedAt = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'slow-model',
        enabled: true,
      },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(200);
    expect(elapsedMs).toBeLessThan(5_500);

    const route = response.json() as { id: number };
    const channels = await db.select()
      .from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, route.id))
      .all();
    expect(channels).toHaveLength(0);
  });

  it('rebuilds selected exact source routes before creating an explicit group', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'explicit-group-source-site',
      url: 'https://explicit-group-source.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'explicit-group-source-user',
      accessToken: 'explicit-group-session',
      apiToken: null,
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'group-target-model',
      available: true,
    }).run();

    const sourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'group-target-model',
      enabled: true,
    }).returning().get();

    getUserGroupsMock.mockResolvedValue(['default', 'cheap']);
    fetchModelPricingCatalogMock.mockResolvedValue({
      groupRatio: { default: 1, cheap: 0.1 },
      models: [{
        modelName: 'group-target-model',
        quotaType: 0,
        modelDescription: null,
        tags: [],
        supportedEndpointTypes: [],
        ownerBy: null,
        enableGroups: ['default', 'cheap'],
        groupPricing: {},
      }],
    });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'metapi-cheap-shared', key: 'sk-group-created', enabled: true, tokenGroup: 'cheap' },
    ]);
    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (credential === 'sk-group-created') return ['group-target-model'];
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'public-group-model',
        sourceRouteIds: [sourceRoute.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);

    const sourceChannels = await db.select()
      .from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, sourceRoute.id))
      .all();
    expect(sourceChannels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: account.id,
        sourceModel: 'group-target-model',
        manualOverride: false,
      }),
    ]));
  });

  it('rebuilds newly selected exact source routes when updating an explicit group', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'explicit-group-update-site',
      url: 'https://explicit-group-update.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'explicit-group-update-user',
      accessToken: 'explicit-group-update-session',
      apiToken: null,
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'existing-group-model',
        available: true,
      },
      {
        accountId: account.id,
        modelName: 'new-group-model',
        available: true,
      },
    ]).run();

    const existingSourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'existing-group-model',
      enabled: true,
    }).returning().get();
    const newSourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'new-group-model',
      enabled: true,
    }).returning().get();

    const groupRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'public-group-model',
      displayName: 'public-group-model',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeGroupSources).values({
      groupRouteId: groupRoute.id,
      sourceRouteId: existingSourceRoute.id,
    }).run();

    getUserGroupsMock.mockResolvedValue(['default', 'cheap']);
    fetchModelPricingCatalogMock.mockResolvedValue({
      groupRatio: { default: 1, cheap: 0.2 },
      models: [{
        modelName: 'new-group-model',
        quotaType: 0,
        modelDescription: null,
        tags: [],
        supportedEndpointTypes: [],
        ownerBy: null,
        enableGroups: ['default', 'cheap'],
        groupPricing: {},
      }],
    });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'metapi-cheap-shared', key: 'sk-update-created', enabled: true, tokenGroup: 'cheap' },
    ]);
    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (credential === 'sk-update-created') return ['new-group-model'];
      return [];
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/routes/${groupRoute.id}`,
      payload: {
        sourceRouteIds: [newSourceRoute.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);

    const sourceChannels = await db.select()
      .from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, newSourceRoute.id))
      .all();
    expect(sourceChannels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: account.id,
        sourceModel: 'new-group-model',
        manualOverride: false,
      }),
    ]));

    const storedSources = await db.select()
      .from(schema.routeGroupSources)
      .where(eq(schema.routeGroupSources.groupRouteId, groupRoute.id))
      .all();
    expect(storedSources.map((item: RouteGroupSourceRow) => item.sourceRouteId)).toEqual([newSourceRoute.id]);
  });

  it('reuses one shared token per group for multiple exact models', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'shared-group-site',
      url: 'https://shared-group-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'shared-group-user',
      accessToken: 'shared-group-session',
      apiToken: null,
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'shared-model-a',
        available: true,
      },
      {
        accountId: account.id,
        modelName: 'shared-model-b',
        available: true,
      },
    ]).run();

    getUserGroupsMock.mockResolvedValue(['default', 'vip']);
    fetchModelPricingCatalogMock.mockResolvedValue({
      groupRatio: { default: 1, vip: 0.2 },
      models: [
        {
          modelName: 'shared-model-a',
          quotaType: 0,
          modelDescription: null,
          tags: [],
          supportedEndpointTypes: [],
          ownerBy: null,
          enableGroups: ['default', 'vip'],
          groupPricing: {},
        },
        {
          modelName: 'shared-model-b',
          quotaType: 0,
          modelDescription: null,
          tags: [],
          supportedEndpointTypes: [],
          ownerBy: null,
          enableGroups: ['default', 'vip'],
          groupPricing: {},
        },
      ],
    });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'metapi-vip-shared', key: 'sk-shared-created', enabled: true, tokenGroup: 'vip' },
    ]);
    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (credential === 'sk-shared-created') return ['shared-model-a', 'shared-model-b'];
      return [];
    });

    const responseA = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'shared-model-a',
        enabled: true,
      },
    });

    const responseB = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'shared-model-b',
        enabled: true,
      },
    });

    expect(responseA.statusCode).toBe(200);
    expect(responseB.statusCode).toBe(200);
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(createApiTokenMock.mock.calls[0]?.[3]).toMatchObject({
      group: 'vip',
      name: 'metapi-vip-shared',
    });
  });

  it('marks auto provision as failed when upstream only returns a masked token after create', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'masked-create-site',
      url: 'https://masked-create-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'masked-create-user',
      accessToken: 'masked-create-session',
      apiToken: null,
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'masked-model',
      available: true,
    }).run();

    getUserGroupsMock.mockResolvedValue(['default', 'vip']);
    fetchModelPricingCatalogMock.mockResolvedValue({
      groupRatio: { default: 1, vip: 0.2 },
      models: [{
        modelName: 'masked-model',
        quotaType: 0,
        modelDescription: null,
        tags: [],
        supportedEndpointTypes: [],
        ownerBy: null,
        enableGroups: ['default', 'vip'],
        groupPricing: {},
      }],
    });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'metapi-vip-shared', key: 'sk-vip***mask', enabled: true, tokenGroup: 'vip' },
    ]);
    getModelsMock.mockResolvedValue([]);

    vi.useFakeTimers();
    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'masked-model',
        enabled: true,
      },
    });
    await vi.runAllTimersAsync();
    const response = await responsePromise;
    vi.useRealTimers();

    expect(response.statusCode).toBe(200);

    const tokens = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokens.some((token) => token.name === 'metapi-vip-shared')).toBe(false);

    const state = await db.select()
      .from(schema.tokenCoverageAutoprovisionStates)
      .where(and(
        eq(schema.tokenCoverageAutoprovisionStates.accountId, account.id),
        eq(schema.tokenCoverageAutoprovisionStates.modelName, 'masked-model'),
        eq(schema.tokenCoverageAutoprovisionStates.targetGroup, 'vip'),
      ))
      .get();
    expect(state).toMatchObject({
      status: 'failed',
      reasonCode: 'created_token_masked_pending',
    });

    const route = response.json() as { id: number };
    const channels = await db.select()
      .from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, route.id))
      .all();
    expect(channels).toHaveLength(0);
  });

  it('retries masked create result and succeeds when upstream later returns plaintext key', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'masked-retry-site',
      url: 'https://masked-retry-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'masked-retry-user',
      accessToken: 'masked-retry-session',
      apiToken: null,
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'masked-retry-model',
      available: true,
    }).run();

    getUserGroupsMock.mockResolvedValue(['default', 'vip']);
    fetchModelPricingCatalogMock.mockResolvedValue({
      groupRatio: { default: 1, vip: 0.2 },
      models: [{
        modelName: 'masked-retry-model',
        quotaType: 0,
        modelDescription: null,
        tags: [],
        supportedEndpointTypes: [],
        ownerBy: null,
        enableGroups: ['default', 'vip'],
        groupPricing: {},
      }],
    });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock
      .mockResolvedValueOnce([
        { name: 'metapi-vip-shared', key: 'sk-vip***mask', enabled: true, tokenGroup: 'vip' },
      ])
      .mockResolvedValueOnce([
        { name: 'metapi-vip-shared', key: 'sk-vip-created-plain', enabled: true, tokenGroup: 'vip' },
      ]);
    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (credential === 'sk-vip-created-plain') return ['masked-retry-model'];
      return [];
    });

    vi.useFakeTimers();
    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'masked-retry-model',
        enabled: true,
      },
    });
    await vi.runAllTimersAsync();
    const response = await responsePromise;
    vi.useRealTimers();

    expect(response.statusCode).toBe(200);
    expect(getApiTokensMock).toHaveBeenCalledTimes(2);

    const tokens = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokens.some((token) => token.token === 'sk-vip-created-plain')).toBe(true);

    const state = await db.select()
      .from(schema.tokenCoverageAutoprovisionStates)
      .where(and(
        eq(schema.tokenCoverageAutoprovisionStates.accountId, account.id),
        eq(schema.tokenCoverageAutoprovisionStates.modelName, 'masked-retry-model'),
        eq(schema.tokenCoverageAutoprovisionStates.targetGroup, 'vip'),
      ))
      .get();
    expect(state).toMatchObject({
      status: 'succeeded',
      reasonCode: 'created',
    });
  });

  it('removes stale auto-managed group token after model drifts to another group', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'drift-cleanup-site',
      url: 'https://drift-cleanup-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'drift-cleanup-user',
      accessToken: 'drift-cleanup-session',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const staleToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'metapi-cheap-shared',
      token: 'sk-old-cheap',
      tokenGroup: 'cheap',
      source: 'sync',
      enabled: true,
      valueStatus: 'ready',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'drift-model',
      available: true,
    }).run();
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: staleToken.id,
      modelName: 'drift-model',
      available: true,
    }).run();

    getUserGroupsMock.mockResolvedValue(['cheap', 'vip']);
    fetchModelPricingCatalogMock.mockResolvedValue({
      groupRatio: { cheap: 1, vip: 0.2 },
      models: [{
        modelName: 'drift-model',
        quotaType: 0,
        modelDescription: null,
        tags: [],
        supportedEndpointTypes: [],
        ownerBy: null,
        enableGroups: ['cheap', 'vip'],
        groupPricing: {},
      }],
    });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'metapi-cheap-shared', key: 'sk-old-cheap', enabled: true, tokenGroup: 'cheap' },
      { name: 'metapi-vip-shared', key: 'sk-new-vip', enabled: true, tokenGroup: 'vip' },
    ]);
    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (credential === 'sk-new-vip') return ['drift-model'];
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'drift-model',
        enabled: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(deleteApiTokenMock).toHaveBeenCalledTimes(1);
    expect(deleteApiTokenMock.mock.calls[0]?.[2]).toBe('sk-old-cheap');

    const remainingTokens = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(remainingTokens.map((item: AccountTokenRow) => item.name)).toEqual(['metapi-vip-shared']);
  });

  it('keeps old shared-group token when another explicit target still needs that group', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'drift-preserve-site',
      url: 'https://drift-preserve-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'drift-preserve-user',
      accessToken: 'drift-preserve-session',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const staleToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'metapi-cheap-shared',
      token: 'sk-preserve-cheap',
      tokenGroup: 'cheap',
      source: 'sync',
      enabled: true,
      valueStatus: 'ready',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'drift-model',
        available: true,
      },
      {
        accountId: account.id,
        modelName: 'steady-model',
        available: true,
      },
    ]).run();
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: staleToken.id,
      modelName: 'steady-model',
      available: true,
    }).run();
    await db.insert(schema.tokenRoutes).values({
      modelPattern: 'steady-model',
      enabled: true,
    }).run();

    getUserGroupsMock.mockResolvedValue(['cheap', 'vip']);
    fetchModelPricingCatalogMock.mockResolvedValue({
      groupRatio: { cheap: 1, vip: 0.2 },
      models: [
        {
          modelName: 'drift-model',
          quotaType: 0,
          modelDescription: null,
          tags: [],
          supportedEndpointTypes: [],
          ownerBy: null,
          enableGroups: ['cheap', 'vip'],
          groupPricing: {},
        },
        {
          modelName: 'steady-model',
          quotaType: 0,
          modelDescription: null,
          tags: [],
          supportedEndpointTypes: [],
          ownerBy: null,
          enableGroups: ['cheap'],
          groupPricing: {},
        },
      ],
    });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'metapi-cheap-shared', key: 'sk-preserve-cheap', enabled: true, tokenGroup: 'cheap' },
      { name: 'metapi-vip-shared', key: 'sk-preserve-vip', enabled: true, tokenGroup: 'vip' },
    ]);
    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (credential === 'sk-preserve-cheap') return ['steady-model'];
      if (credential === 'sk-preserve-vip') return ['drift-model'];
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'drift-model',
        enabled: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(deleteApiTokenMock).not.toHaveBeenCalled();

    const remainingTokens = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(remainingTokens.map((item: AccountTokenRow) => item.name).sort()).toEqual([
      'metapi-cheap-shared',
      'metapi-vip-shared',
    ]);
  });
});
