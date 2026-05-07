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
type TokenRouterModule = typeof import('../../services/tokenRouter.js');

describe('/api/models/marketplace', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-stats-marketplace-'));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./stats.js');
    const customRoutesModule = await import('../../custom/register.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;

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
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
  });

  afterAll(async () => {
    await app.close();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
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

  it('returns site-specific pricing ratios for the same marketplace model', async () => {
    const siteA = await db.insert(schema.sites).values({
      name: 'pricing-site-a',
      url: 'https://pricing-site-a.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const siteB = await db.insert(schema.sites).values({
      name: 'pricing-site-b',
      url: 'https://pricing-site-b.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: siteA.id,
      username: 'pricing-a',
      accessToken: 'session-a',
      status: 'active',
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: siteB.id,
      username: 'pricing-b',
      accessToken: 'session-b',
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: accountA.id,
        modelName: 'gpt-priced',
        available: true,
      },
      {
        accountId: accountB.id,
        modelName: 'gpt-priced',
        available: true,
      },
    ]).run();

    fetchMock.mockImplementation(async (url: string) => {
      const modelRatio = url.includes('pricing-site-a') ? 2 : 5;
      const groupRatio = url.includes('pricing-site-a')
        ? { default: 1, vip: 0.5 }
        : { default: 3, vip: 2 };
      return new Response(JSON.stringify({
        data: [
          {
            model_name: 'gpt-priced',
            quota_type: 0,
            model_ratio: modelRatio,
            completion_ratio: 2,
            enable_groups: ['default', 'vip'],
          },
        ],
        group_ratio: groupRatio,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/models/marketplace?includePricing=1',
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    const model = json.models.find((item: any) => item.name === 'gpt-priced');
    expect(model).toBeTruthy();
    expect(model.pricingSources).toHaveLength(2);
    expect(model.pricingSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        siteName: 'pricing-site-a',
        groupRatio: { default: 1, vip: 0.5 },
        groupPricing: expect.objectContaining({
          default: expect.objectContaining({ inputPerMillion: 4, outputPerMillion: 8 }),
          vip: expect.objectContaining({ inputPerMillion: 2, outputPerMillion: 4 }),
        }),
      }),
      expect.objectContaining({
        siteName: 'pricing-site-b',
        groupRatio: { default: 3, vip: 2 },
        groupPricing: expect.objectContaining({
          default: expect.objectContaining({ inputPerMillion: 30, outputPerMillion: 60 }),
          vip: expect.objectContaining({ inputPerMillion: 20, outputPerMillion: 40 }),
        }),
      }),
    ]));
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
    getModelsMock.mockResolvedValue(['gpt-4.1', 'gpt-4o']);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      id: 'ok',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    }), {
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

  it('retries realtime probe with a fallback prompt when smart moderation blocks the canary', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'moderation-retry-site',
      url: 'https://moderation-retry.example.com',
      platform: 'new-api',
      status: 'active',
      apiKey: 'sk-moderation-retry',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'deepseek-user',
      accessToken: 'session-token',
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'DeepSeek-v4-pro',
      available: true,
      latencyMs: 180,
    }).run();

    getModelsMock.mockResolvedValue(['DeepSeek-v4-pro']);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Smart moderation blocked by hashlinear_model (confidence: 0.414)' },
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'ok',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'DeepSeek-v4-pro',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      available: true,
      probeEndpoint: 'chat',
      probeClassification: 'supported',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body || '{}'));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body || '{}'));
    expect(firstBody.messages[0].content).toBe('OK');
    expect(secondBody.messages[0].content).toBe('ping');
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

  it('tests marketplace availability against the selected route channel when routeId is provided', async () => {
    const tokensRoutesModule = await import('./tokens.js');
    const routeApp = Fastify();
    await routeApp.register(tokensRoutesModule.tokensRoutes);

    try {
      const site = await db.insert(schema.sites).values({
        name: 'route-marketplace-site',
        url: 'https://route-marketplace.example.com',
        platform: 'new-api',
        status: 'active',
      }).returning().get();

      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'route-marketplace-user',
        accessToken: 'session-token',
        status: 'active',
        balance: 10,
      }).returning().get();

      const token = await db.insert(schema.accountTokens).values({
        accountId: account.id,
        name: 'route-marketplace-token',
        token: 'sk-route-marketplace',
        enabled: true,
        isDefault: true,
        valueStatus: 'ready',
      }).returning().get();

      const route = await db.insert(schema.tokenRoutes).values({
        modelPattern: 'gpt-5.4',
        enabled: true,
      }).returning().get();

      await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: 'gpt-5.4',
        enabled: true,
      }).run();

      getModelsMock.mockResolvedValue(['gpt-5.4']);
      fetchMock.mockResolvedValue(new Response(JSON.stringify({
        id: 'ok',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/api/models/marketplace/test',
        payload: {
          modelName: 'gpt-5.4',
          routeId: route.id,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        available: true,
        routeId: route.id,
        channelId: expect.any(Number),
        usedTokenId: token.id,
        usedTokenName: token.name,
      });
    } finally {
      await routeApp.close();
    }
  });

  it('uses the real selected route channel when marketplace test is called without routeId', async () => {
    const siteBad = await db.insert(schema.sites).values({
      name: 'glm-bad-site',
      url: 'https://glm-bad.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const accountBad = await db.insert(schema.accounts).values({
      siteId: siteBad.id,
      username: 'glm-bad-user',
      accessToken: 'bad-session',
      status: 'active',
      balance: 1,
    }).returning().get();

    const tokenBad = await db.insert(schema.accountTokens).values({
      accountId: accountBad.id,
      name: 'glm-bad-token',
      token: 'sk-glm-bad',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    const siteGood = await db.insert(schema.sites).values({
      name: 'glm-good-site',
      url: 'https://glm-good.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const accountGood = await db.insert(schema.accounts).values({
      siteId: siteGood.id,
      username: 'glm-good-user',
      accessToken: 'good-session',
      status: 'active',
      balance: 100,
    }).returning().get();

    const tokenGood = await db.insert(schema.accountTokens).values({
      accountId: accountGood.id,
      name: 'glm-good-token',
      token: 'sk-glm-good',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'glm-5.1',
      enabled: true,
    }).returning().get();

    const insertedChannels = await db.insert(schema.routeChannels).values([
      {
        routeId: route.id,
        accountId: accountBad.id,
        tokenId: tokenBad.id,
        sourceModel: 'glm-5.1',
        priority: 1,
        weight: 1,
        enabled: true,
      },
      {
        routeId: route.id,
        accountId: accountGood.id,
        tokenId: tokenGood.id,
        sourceModel: 'glm-5.1',
        priority: 0,
        weight: 10,
        enabled: true,
      },
    ]).returning().all();
    const channelGood = insertedChannels.find((channel) => channel.tokenId === tokenGood.id);
    expect(channelGood).toBeTruthy();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: accountBad.id,
        modelName: 'glm-5.1',
        available: true,
        checkedAt: new Date().toISOString(),
      },
      {
        accountId: accountGood.id,
        modelName: 'glm-5.1',
        available: true,
        checkedAt: new Date().toISOString(),
      },
    ]).run();
    invalidateTokenRouterCache();

    getModelsMock.mockImplementation(async (_url: string, token: string) => {
      if (token === tokenBad.token) return ['glm-5.1'];
      if (token === tokenGood.token) return ['glm-5.1'];
      return [];
    });

    fetchMock.mockImplementation(async (_url: string, init?: Record<string, unknown>) => {
      const headers = ((init?.headers || {}) as Record<string, string>);
      const auth = String(headers.Authorization || '');
      if (auth.includes(tokenBad.token)) {
        return new Response(JSON.stringify({ error: { message: 'Authentication Failed' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'glm-ok',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'glm-5.1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      available: true,
      routeId: route.id,
      usedTokenId: tokenGood.id,
      usedTokenName: tokenGood.name,
    });
    const fetchArgs = fetchMock.mock.calls[0] ?? [];
    const headers = ((fetchArgs[1] as any)?.headers || {}) as Record<string, string>;
    expect(String(fetchArgs[0] || '')).toContain('http://127.0.0.1:4000/v1/chat/completions');
    expect(headers.Authorization || '').toContain('Bearer ');
    expect(headers['x-metapi-tester-request']).toBe('1');
    expect(headers['x-metapi-tester-forced-channel-id']).toBe(String(channelGood.id));
  });

  it('tests marketplace route availability against the selected channel sourceModel alias', async () => {
    const tokensRoutesModule = await import('./tokens.js');
    const routeApp = Fastify();
    await routeApp.register(tokensRoutesModule.tokensRoutes);

    try {
      const site = await db.insert(schema.sites).values({
        name: 'route-alias-marketplace-site',
        url: 'https://route-alias-marketplace.example.com',
        platform: 'new-api',
        status: 'active',
      }).returning().get();

      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'route-alias-user',
        accessToken: 'session-token',
        status: 'active',
        balance: 10,
      }).returning().get();

      const token = await db.insert(schema.accountTokens).values({
        accountId: account.id,
        name: 'route-alias-token',
        token: 'sk-route-alias',
        enabled: true,
        isDefault: true,
        valueStatus: 'ready',
      }).returning().get();

      const route = await db.insert(schema.tokenRoutes).values({
        modelPattern: 'gemini-3.0-pro',
        displayName: 'gemini-3.0-pro',
        routeMode: 'explicit_group',
        enabled: true,
      }).returning().get();

      await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: account.id,
        tokenId: token.id,
        sourceModel: 'gemini-3-pro-preview',
        enabled: true,
      }).run();

      getModelsMock.mockResolvedValue(['gemini-3-pro-preview']);
      fetchMock.mockResolvedValue(new Response(JSON.stringify({
        id: 'ok',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/api/models/marketplace/test',
        payload: {
          modelName: 'gemini-3.0-pro',
          routeId: route.id,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        available: true,
        routeId: route.id,
      });
      expect(getModelsMock).toHaveBeenCalledWith(site.url, token.token, undefined);
      const fetchArgs = fetchMock.mock.calls[0] ?? [];
      expect(String(fetchArgs[0] || '')).toContain('/v1/chat/completions');
      expect(JSON.parse(String((fetchArgs[1] as any)?.body || '{}'))).toMatchObject({
        model: 'gemini-3-pro-preview',
      });
    } finally {
      await routeApp.close();
    }
  });

  it('uses local proxy canary semantics when marketplace test targets a known channel', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'proxy-canary-site',
      url: 'https://proxy-canary.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'proxy-canary-user',
      accessToken: 'session-token',
      status: 'active',
      balance: 10,
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'proxy-canary-token',
      token: 'sk-proxy-canary',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gemini-2.5-pro',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'gemini-2.5-pro-search',
      enabled: true,
    }).returning().get();

    getModelsMock.mockResolvedValue(['gemini-2.5-pro-search']);
    fetchMock.mockImplementation(async (url: string, init?: Record<string, unknown>) => {
      if (String(url).startsWith('http://127.0.0.1:4000/')) {
        const headers = (init?.headers || {}) as Record<string, string>;
        expect(headers.Authorization).toBeDefined();
        expect(headers['x-metapi-tester-request']).toBe('1');
        expect(headers['x-metapi-tester-forced-channel-id']).toBe(String(channel.id));
        return new Response(JSON.stringify({
          id: 'proxy-ok',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        id: 'upstream-empty',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'gemini-2.5-pro',
        channelId: channel.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      available: true,
      routeId: route.id,
      channelId: channel.id,
      probeEndpoint: 'proxy-chat',
      probeClassification: 'supported',
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0] || '').startsWith('http://127.0.0.1:4000/v1/chat/completions'))).toBe(true);
  });

  it('pins default marketplace local proxy canary to the preview-selected channel', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'default-proxy-pin-site',
      url: 'https://default-proxy-pin.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'default-proxy-pin-user',
      accessToken: 'session-token',
      status: 'active',
      balance: 10,
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default-proxy-pin-token',
      token: 'sk-default-proxy-pin',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gemini-default-proxy-pin',
      displayName: 'gemini-default-proxy-pin',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'gemini-default-proxy-pin-search',
      enabled: true,
    }).returning().get();

    getModelsMock.mockResolvedValue(['gemini-default-proxy-pin-search']);
    fetchMock.mockImplementation(async (url: string, init?: Record<string, unknown>) => {
      if (String(url).startsWith('http://127.0.0.1:4000/')) {
        const headers = (init?.headers || {}) as Record<string, string>;
        expect(headers.Authorization).toBeDefined();
        expect(headers['x-metapi-tester-request']).toBe('1');
        expect(headers['x-metapi-tester-forced-channel-id']).toBe(String(channel.id));
        return new Response(JSON.stringify({
          id: 'proxy-ok',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error('unexpected upstream probe path');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'gemini-default-proxy-pin',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      available: true,
      routeId: route.id,
      channelId: channel.id,
      probeEndpoint: 'proxy-chat',
      probeClassification: 'supported',
    });
  });
});
