import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');
type ProxyRouterModule = typeof import('./router.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');

describe('/v1/models route', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let proxyRoutes: ProxyRouterModule['proxyRoutes'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let app: FastifyInstance;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-models-route-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const proxyRouterModule = await import('./router.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');

    db = dbModule.db;
    schema = dbModule.schema;
    proxyRoutes = proxyRouterModule.proxyRoutes;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;

    app = Fastify();
    await app.register(proxyRoutes);
  });

  beforeEach(async () => {
    invalidateTokenRouterCache();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('hides models that have no routable channel even if model availability contains them', async () => {
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

    await db.insert(schema.downstreamApiKeys).values({
      name: 'managed-key',
      key: 'sk-managed-models',
      enabled: true,
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

    const ids = body.data.map((item) => item.id);
    expect(ids).toContain('routable-model');
    expect(ids).not.toContain('orphan-model');
  });

  it('returns only whitelist models for managed key with supportedModels policy', async () => {
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
    const ids = body.data.map((item) => item.id);
    expect(ids).toContain('allowed-model');
    expect(ids).not.toContain('blocked-model');
  });
});
