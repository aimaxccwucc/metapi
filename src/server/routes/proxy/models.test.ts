import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const refreshModelsAndRebuildRoutesMock = vi.fn(async () => undefined);

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

type DbModule = typeof import('../../db/index.js');
type ModelsRouteModule = typeof import('./models.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');
type ConfigModule = typeof import('../../config.js');
type AuthModule = typeof import('../../middleware/auth.js');

describe('/v1/models route', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let modelsProxyRoute: ModelsRouteModule['modelsProxyRoute'];
  let proxyAuthMiddleware: AuthModule['proxyAuthMiddleware'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let config: ConfigModule['config'];
  let app: FastifyInstance;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-models-route-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const modelsRouteModule = await import('./models.js');
    const authModule = await import('../../middleware/auth.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    const configModule = await import('../../config.js');

    db = dbModule.db;
    schema = dbModule.schema;
    modelsProxyRoute = modelsRouteModule.modelsProxyRoute;
    proxyAuthMiddleware = authModule.proxyAuthMiddleware;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    config = configModule.config;
    config.proxyToken = 'sk-global-proxy-token';

    app = Fastify();
    app.addHook('onRequest', async (request, reply) => {
      await proxyAuthMiddleware(request, reply);
    });
    await app.register(modelsProxyRoute);
  }, 20000);

  beforeEach(async () => {
    invalidateTokenRouterCache();
    refreshModelsAndRebuildRoutesMock.mockClear();
    config.globalAllowedModels = [];
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    delete process.env.DATA_DIR;
  });

  it('returns no public models when only automatic exact routes exist', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'test-site',
      url: 'https://upstream.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'account-access-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'account-api-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'routable-model',
        available: true,
      },
      {
        accountId: account.id,
        modelName: 'orphan-model',
        available: true,
      },
    ]).run();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'routable-model',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'routable-model',
      enabled: true,
    }).run();

    await db.insert(schema.tokenRoutes).values({
      modelPattern: 'routable-model',
      displayName: 'routable-model',
      routeMode: 'explicit_group',
      enabled: true,
    }).run();

    await db.insert(schema.downstreamApiKeys).values({
      name: 'managed-key',
      key: 'sk-managed-models',
      enabled: true,
      supportedModels: JSON.stringify(['routable-model']),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: 'Bearer sk-managed-models',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      object: 'list';
      data: Array<{ id: string }>;
    };

    expect(body.data).toEqual([]);
  });

  it('returns no public models for global proxy token when only automatic exact routes exist', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'global-site',
      url: 'https://global.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'global-access-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'global-api-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'global-routable-model',
      available: true,
    }).run();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'global-routable-model',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'global-routable-model',
      enabled: true,
    }).run();

    await db.insert(schema.tokenRoutes).values({
      modelPattern: 'global-routable-model',
      displayName: 'global-routable-model',
      routeMode: 'explicit_group',
      enabled: true,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: 'Bearer sk-global-proxy-token',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      object: 'list';
      data: Array<{ id: string }>;
    };

    expect(body.data).toEqual([]);
  });

  it('returns no models for managed key when only automatic exact routes exist', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'test-site',
      url: 'https://upstream.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'account-access-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'account-api-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'allowed-model',
        available: true,
      },
      {
        accountId: account.id,
        modelName: 'blocked-model',
        available: true,
      },
    ]).run();

    const allowedRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'allowed-model',
      enabled: true,
    }).returning().get();
    const blockedRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'blocked-model',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: allowedRoute.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: 'allowed-model',
        enabled: true,
      },
      {
        routeId: blockedRoute.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: 'blocked-model',
        enabled: true,
      },
    ]).run();

    await db.insert(schema.tokenRoutes).values({
      modelPattern: 'allowed-model',
      displayName: 'allowed-model',
      routeMode: 'explicit_group',
      enabled: true,
    }).run();

    await db.insert(schema.downstreamApiKeys).values({
      name: 'managed-key',
      key: 'sk-managed-whitelist',
      enabled: true,
      supportedModels: JSON.stringify(['allowed-model']),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: 'Bearer sk-managed-whitelist',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      object: 'list';
      data: Array<{ id: string }>;
    };
    expect(body.data).toEqual([]);
  });

  it('returns no models when allowedRouteIds points only to automatic routes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'test-site',
      url: 'https://upstream.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'account-access-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'account-api-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'claude-opus-4-5',
        available: true,
      },
      {
        accountId: account.id,
        modelName: 'claude-sonnet-4-5',
        available: true,
      },
    ]).run();

    const groupRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-5$',
      displayName: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: groupRoute.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
    }).run();

    await db.insert(schema.downstreamApiKeys).values({
      name: 'managed-key',
      key: 'sk-managed-group-only',
      enabled: true,
      allowedRouteIds: JSON.stringify([groupRoute.id]),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: 'Bearer sk-managed-group-only',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      object: 'list';
      data: Array<{ id: string }>;
    };

    expect(body.data).toEqual([]);
  });

  it('returns no models for managed key with empty model and group selections', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'deny-all-site',
      url: 'https://deny-all.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'deny-all-access-token',
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'gpt-4o-mini',
        available: true,
      },
      {
        accountId: account.id,
        modelName: 'claude-opus-4-6',
        available: true,
      },
    ]).run();

    await db.insert(schema.downstreamApiKeys).values({
      name: 'managed-key-deny-all',
      key: 'sk-managed-deny-all',
      enabled: true,
      supportedModels: JSON.stringify([]),
      allowedRouteIds: JSON.stringify([]),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: 'Bearer sk-managed-deny-all',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      object: 'list';
      data: Array<{ id: string }>;
    };

    expect(body.data).toEqual([]);
  });

  it('filters models by globalAllowedModels for global proxy token', async () => {
    config.globalAllowedModels = ['gpt-*'];

    const site = await db.insert(schema.sites).values({
      name: 'global-filter-site',
      url: 'https://global-filter.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'global-filter-access-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'global-filter-api-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const gptRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      displayName: 'gpt-4o-mini',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();
    const claudeRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-sonnet-4-6',
      displayName: 'claude-sonnet-4-6',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: gptRoute.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: 'gpt-4o-mini',
        enabled: true,
      },
      {
        routeId: claudeRoute.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: 'claude-sonnet-4-6',
        enabled: true,
      },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: 'Bearer sk-global-proxy-token',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((item) => item.id)).toEqual(['gpt-4o-mini']);
  });

  it('returns only explicit-group public name while hiding source exact routes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'explicit-group-site',
      url: 'https://explicit-group.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'explicit-group-access-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'explicit-group-api-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'claude-opus-4-5',
        available: true,
      },
      {
        accountId: account.id,
        modelName: 'claude-sonnet-4-5',
        available: true,
      },
    ]).run();

    const sourceRouteA = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-5',
      enabled: true,
    }).returning().get();
    const sourceRouteB = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-sonnet-4-5',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: sourceRouteA.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: 'claude-opus-4-5',
        enabled: true,
      },
      {
        routeId: sourceRouteB.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: 'claude-sonnet-4-5',
        enabled: true,
      },
    ]).run();

    await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4.1',
      displayName: 'gpt-4.1',
      routeMode: 'explicit_group',
      enabled: true,
    }).run();

    const groupRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-6',
      displayName: 'claude-opus-4-6',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeGroupSources).values([
      {
        groupRouteId: groupRoute.id,
        sourceRouteId: sourceRouteA.id,
      },
      {
        groupRouteId: groupRoute.id,
        sourceRouteId: sourceRouteB.id,
      },
    ]).run();

    await db.insert(schema.downstreamApiKeys).values({
      name: 'managed-explicit-group-key',
      key: 'sk-managed-explicit-group',
      enabled: true,
      allowedRouteIds: JSON.stringify([groupRoute.id]),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: 'Bearer sk-managed-explicit-group',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      object: 'list';
      data: Array<{ id: string }>;
    };

    const ids = body.data.map((item) => item.id);
    expect(ids).toContain('claude-opus-4-6');
    expect(ids).not.toContain('claude-opus-4-5');
    expect(ids).not.toContain('claude-sonnet-4-5');
  });

  it('does not rebuild routes when visible models exist but policy filtering removes them all', async () => {
    config.globalAllowedModels = ['gpt-*'];

    const site = await db.insert(schema.sites).values({
      name: 'policy-empty-site',
      url: 'https://policy-empty.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'policy-empty-access-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'policy-empty-api-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-sonnet-4-6',
      displayName: 'claude-sonnet-4-6',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'claude-sonnet-4-6',
      enabled: true,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: 'Bearer sk-global-proxy-token',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ id: string }> };
    expect(body.data).toEqual([]);
  });

  it('returns no models when only automatic routes remain after filtering pseudo models', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'search-site',
      url: 'https://search.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'search-access-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'search-api-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: '__search',
        available: true,
      },
      {
        accountId: account.id,
        modelName: '__tavily_search',
        available: true,
      },
      {
        accountId: account.id,
        modelName: 'gpt-4.1',
        available: true,
      },
    ]).run();

    const searchRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: '__search',
      enabled: true,
    }).returning().get();

    const llmRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4.1',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: searchRoute.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: '__search',
        enabled: true,
      },
      {
        routeId: llmRoute.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: 'gpt-4.1',
        enabled: true,
      },
    ]).run();

    await db.insert(schema.downstreamApiKeys).values({
      name: 'search-key',
      key: 'sk-search-key',
      enabled: true,
      supportedModels: JSON.stringify(['gpt-4.1']),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: 'Bearer sk-search-key',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      object: 'list';
      data: Array<{ id: string }>;
    };
    expect(body.data).toEqual([]);
  });
});
