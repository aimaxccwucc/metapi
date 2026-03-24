import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getApiTokensMock = vi.fn();
const getApiTokenMock = vi.fn();
const createApiTokenMock = vi.fn();
const getUserGroupsMock = vi.fn();
const getModelsMock = vi.fn();
const fetchModelPricingCatalogMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    createApiToken: (...args: unknown[]) => createApiTokenMock(...args),
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
    getUserGroupsMock.mockReset();
    getModelsMock.mockReset();
    fetchModelPricingCatalogMock.mockReset();

    getApiTokensMock.mockResolvedValue([]);
    getApiTokenMock.mockResolvedValue(null);
    createApiTokenMock.mockResolvedValue(false);
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
      { name: 'metapi-vip-kimi-k2-5', key: 'sk-vip-created', enabled: true, tokenGroup: 'vip' },
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
      { name: 'metapi-cheap-group-target-model', key: 'sk-group-created', enabled: true, tokenGroup: 'cheap' },
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
      { name: 'metapi-cheap-new-group-model', key: 'sk-update-created', enabled: true, tokenGroup: 'cheap' },
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
});
