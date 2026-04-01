import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

const getModelsMock = vi.fn();
const getUserGroupsMock = vi.fn();
const createApiTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const withSiteProxyRequestInitMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getModels: (...args: unknown[]) => getModelsMock(...args),
    getUserGroups: (...args: unknown[]) => getUserGroupsMock(...args),
    createApiToken: (...args: unknown[]) => createApiTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

vi.mock('../../services/siteProxy.js', () => ({
  withSiteProxyRequestInit: (...args: unknown[]) => withSiteProxyRequestInitMock(...args),
}));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

type DbModule = typeof import('../../db/index.js');

describe('/api/models/marketplace', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-stats-marketplace-'));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./stats.js');
    const customRoutesModule = await import('../../custom/register.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.statsRoutes);
    await app.register(customRoutesModule.registerCustomRoutes);
  });

  beforeEach(async () => {
    getModelsMock.mockReset();
    getUserGroupsMock.mockReset();
    createApiTokenMock.mockReset();
    getApiTokensMock.mockReset();
    withSiteProxyRequestInitMock.mockReset();
    fetchMock.mockReset();
    withSiteProxyRequestInitMock.mockImplementation(async (_url: string, init: Record<string, unknown>) => init);

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns account-level discovered models even when account has no managed tokens', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-no-token',
      url: 'https://site-no-token.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'session-token',
      status: 'active',
      balance: 12.5,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'claude-sonnet-4-5-20250929',
      available: true,
      latencyMs: 233,
    }).run();

    const visibleRows = await db.select().from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();
    expect(visibleRows).toHaveLength(1);

    const response = await app.inject({
      method: 'GET',
      url: '/api/models/marketplace',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      models: Array<{
        name: string;
        accountCount: number;
        tokenCount: number;
        accounts: Array<{
          id: number;
          site: string;
          username: string | null;
          tokens: Array<{ id: number; name: string; isDefault: boolean }>;
        }>;
      }>;
    };
    const model = body.models.find((item) => item.name === 'claude-sonnet-4-5-20250929');
    expect(model).toBeDefined();
    expect(model?.accountCount).toBe(1);
    expect(model?.tokenCount).toBe(0);
    expect(model?.accounts).toHaveLength(1);
    expect(model?.accounts[0]).toMatchObject({
      id: account.id,
      site: 'site-no-token',
      username: 'alice',
      tokens: [],
    });
  });

  it('tests marketplace model availability and auto-creates a scoped key when needed', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'probe-site',
      url: 'https://probe.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'bob',
      accessToken: 'session-token',
      status: 'active',
      extraConfig: JSON.stringify({ platformUserId: 114514 }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 120,
    }).run();

    getUserGroupsMock.mockResolvedValue(['default', 'vip']);
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'metapi-default-gpt-4-1', key: 'sk-new', enabled: true, tokenGroup: 'default' },
    ]);
    getModelsMock.mockResolvedValue(['gpt-4o']);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'gpt-4.1',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      available: true,
      accountId: account.id,
      siteId: site.id,
      autoKeyCreated: true,
      autoKeyGroup: 'default',
      autoKeyTokenId: expect.any(Number),
    });
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(createApiTokenMock.mock.calls[0]?.[3]).toMatchObject({
      group: 'default',
      modelLimitsEnabled: true,
      modelLimits: 'gpt-4.1',
    });
  });

  it('returns protocol mismatch classification when upstream suggests another request style', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'gemini-site',
      url: 'https://gemini-probe.example.com',
      platform: 'new-api',
      status: 'active',
      apiKey: 'sk-gemini-probe',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'gemini-user',
      accessToken: 'session-token',
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gemini-2.5-pro',
      available: true,
      latencyMs: 200,
    }).run();

    getModelsMock.mockResolvedValue(['gpt-4o']);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Please use /v1beta/models/{model}:generateContent with x-goog-api-key' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'gemini-2.5-pro',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      available: false,
      probeClassification: 'protocol_mismatch',
      probeEndpoint: 'chat',
    });
    expect(String(response.json().reason || '')).toContain('不同的请求协议');
  });

  it('accepts gemini native probe when openai-compatible probe misses', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'gemini-native',
      url: 'https://gemini-native.example.com',
      platform: 'new-api',
      status: 'active',
      apiKey: 'sk-gemini-native',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'native-user',
      accessToken: 'session-token',
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gemini-2.5-pro',
      available: true,
      latencyMs: 200,
    }).run();

    getModelsMock.mockResolvedValue(['gpt-4o']);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Please use /v1beta/models/{model}:generateContent with x-goog-api-key' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Please use /v1beta/models/{model}:generateContent with x-goog-api-key' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'x-goog-api-key is required' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'gemini-2.5-pro',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      available: true,
      probeEndpoint: 'gemini-native',
      probeClassification: 'supported',
    });
  });

  it('uses route channel token credential when probing a route and applies governance', async () => {
    const tokensRoutesModule = await import('./tokens.js');
    const governanceModule = await import('../../services/routingGovernanceService.js');
    const routeApp = Fastify();
    await routeApp.register(tokensRoutesModule.tokensRoutes);

    try {
      const site = await db.insert(schema.sites).values({
        name: 'route-probe-site',
        url: 'https://route-probe.example.com',
        platform: 'new-api',
        status: 'active',
      }).returning().get();

      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'route-user',
        accessToken: 'session-token',
        status: 'active',
      }).returning().get();

      const token = await db.insert(schema.accountTokens).values({
        accountId: account.id,
        name: 'scoped-token',
        token: 'sk-route-probe',
        enabled: true,
        isDefault: false,
        valueStatus: 'ready',
      }).returning().get();

      const route = await db.insert(schema.tokenRoutes).values({
        modelPattern: 'gpt-4.1',
        enabled: true,
      }).returning().get();

      await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: 'gpt-4.1',
        enabled: true,
      }).run();

      await db.insert(schema.modelAvailability).values({
        accountId: account.id,
        modelName: 'gpt-4.1',
        available: true,
      }).run();

      getModelsMock.mockResolvedValue([]);
      fetchMock.mockResolvedValue(new Response(JSON.stringify({
        error: { message: 'This token has no access to model gpt-4.1' },
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }));

      const response = await routeApp.inject({
        method: 'POST',
        url: `/api/routes/${route.id}/probe`,
        payload: { autoGovernance: true },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        success: true;
        unavailableCount: number;
        items: Array<{
          tokenId: number | null;
          probeClassification: string | null;
          governanceAction: string;
          governanceReasonCode: string | null;
        }>;
      };
      expect(body.success).toBe(true);
      expect(body.unavailableCount).toBe(1);
      expect(body.items[0]).toMatchObject({
        tokenId: token.id,
        probeClassification: 'credential',
        governanceAction: 'suppressed',
        governanceReasonCode: 'auth',
      });
      const authGovernance = await governanceModule.listActiveRoutingGovernanceStates({
        subjectTypes: ['token'],
        reasonCodes: ['auth'],
        limit: 20,
      });
      expect(authGovernance.some((item) => item.subjectId === token.id)).toBe(true);
    } finally {
      await routeApp.close();
    }
  });
});
