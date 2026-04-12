import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getModelsMock = vi.fn();
const withSiteProxyRequestInitMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getModels: (...args: unknown[]) => getModelsMock(...args),
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
type ModelCircuitModule = typeof import('../../services/modelCircuitBreaker.js');
type UpstreamEndpointModule = typeof import('../proxy/upstreamEndpoint.js');
type SiteProtocolConfigModule = typeof import('../../services/siteProtocolConfigService.js');
type UpstreamProtocolProfileModule = typeof import('../../services/upstreamProtocolProfile.js');
type CheckinSiteRuntimeModule = typeof import('../../services/checkinSiteRuntime.js');
type RoutingGovernanceModule = typeof import('../../services/routingGovernanceService.js');

describe('GET /api/routes/diagnostics', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let tokenRouter: TokenRouterModule['tokenRouter'];
  let resetAllModelCircuits: ModelCircuitModule['resetAllModelCircuits'];
  let openModelCircuitImmediately: ModelCircuitModule['openModelCircuitImmediately'];
  let resetUpstreamEndpointRuntimeState: UpstreamEndpointModule['resetUpstreamEndpointRuntimeState'];
  let recordUpstreamEndpointFailure: UpstreamEndpointModule['recordUpstreamEndpointFailure'];
  let resetSiteProtocolConfigState: SiteProtocolConfigModule['resetSiteProtocolConfigState'];
  let upsertSiteProtocolConfig: SiteProtocolConfigModule['upsertSiteProtocolConfig'];
  let resetUpstreamProtocolProfileState: UpstreamProtocolProfileModule['resetUpstreamProtocolProfileState'];
  let recordCheckinSiteResolution: CheckinSiteRuntimeModule['recordCheckinSiteResolution'];
  let resetCheckinSiteRuntimeState: CheckinSiteRuntimeModule['resetCheckinSiteRuntimeState'];
  let upsertRoutingGovernanceState: RoutingGovernanceModule['upsertRoutingGovernanceState'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-diagnostics-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    const modelCircuitModule = await import('../../services/modelCircuitBreaker.js');
    const upstreamEndpointModule = await import('../proxy/upstreamEndpoint.js');
    const siteProtocolConfigModule = await import('../../services/siteProtocolConfigService.js');
    const upstreamProtocolProfileModule = await import('../../services/upstreamProtocolProfile.js');
    const checkinSiteRuntimeModule = await import('../../services/checkinSiteRuntime.js');
    const routingGovernanceModule = await import('../../services/routingGovernanceService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    tokenRouter = tokenRouterModule.tokenRouter;
    resetAllModelCircuits = modelCircuitModule.resetAllModelCircuits;
    openModelCircuitImmediately = modelCircuitModule.openModelCircuitImmediately;
    resetUpstreamEndpointRuntimeState = upstreamEndpointModule.resetUpstreamEndpointRuntimeState;
    recordUpstreamEndpointFailure = upstreamEndpointModule.recordUpstreamEndpointFailure;
    resetSiteProtocolConfigState = siteProtocolConfigModule.resetSiteProtocolConfigState;
    upsertSiteProtocolConfig = siteProtocolConfigModule.upsertSiteProtocolConfig;
    resetUpstreamProtocolProfileState = upstreamProtocolProfileModule.resetUpstreamProtocolProfileState;
    recordCheckinSiteResolution = checkinSiteRuntimeModule.recordCheckinSiteResolution;
    resetCheckinSiteRuntimeState = checkinSiteRuntimeModule.resetCheckinSiteRuntimeState;
    upsertRoutingGovernanceState = routingGovernanceModule.upsertRoutingGovernanceState;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    getModelsMock.mockReset();
    withSiteProxyRequestInitMock.mockReset();
    fetchMock.mockReset();
    withSiteProxyRequestInitMock.mockImplementation(async (_url: string, init: Record<string, unknown>) => init);

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routingGovernanceStates).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();

    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    resetAllModelCircuits();
    resetUpstreamEndpointRuntimeState();
    resetSiteProtocolConfigState();
    resetUpstreamProtocolProfileState();
    resetCheckinSiteRuntimeState();
  });

  afterAll(async () => {
    await app.close();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    resetAllModelCircuits();
    resetUpstreamEndpointRuntimeState();
    resetSiteProtocolConfigState();
    resetUpstreamProtocolProfileState();
    resetCheckinSiteRuntimeState();
    delete process.env.DATA_DIR;
  });

  it('returns aggregated runtime diagnostics snapshots for route stability and checkin TODO', async () => {
    const now = new Date();
    const nowIso = now.toISOString();
    const nowSql = nowIso.slice(0, 19).replace('T', ' ');

    const site = await db.insert(schema.sites).values({
      name: 'diag-site',
      url: 'https://diag-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'diag-user',
      accessToken: 'diag-access',
      apiToken: 'sk-diag-token',
      status: 'active',
      checkinEnabled: true,
      extraConfig: JSON.stringify({
        runtimeHealth: {
          state: 'degraded',
          reason: 'needs attention',
          source: 'checkin',
          checkedAt: '2026-03-25T00:00:00.000Z',
        },
        checkinSnapshot: {
          version: 1,
          status: 'manual_required',
          reasonCode: 'manual_turnstile_required',
          retryable: false,
          requiresManual: true,
          unsupported: false,
          lastAttemptAt: '2026-03-25T00:00:00.000Z',
          message: '站点开启了 Turnstile 校验，需要人工签到',
          source: 'checkin',
        },
      }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-diag-token',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'gpt-4o-mini',
      priority: 0,
      weight: 10,
      enabled: true,
      cooldownUntil: '2099-01-01T00:00:00.000Z',
      consecutiveFailCount: 2,
      failCount: 3,
    }).returning().get();

    await db.insert(schema.checkinLogs).values({
      accountId: account.id,
      status: 'skipped',
      message: '站点开启了 Turnstile 校验，需要人工签到',
      createdAt: nowSql,
    }).run();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4o-mini',
      available: false,
      checkedAt: nowIso,
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-4o-mini',
      available: false,
      checkedAt: nowIso,
    }).run();

    await upsertSiteProtocolConfig(site.id, {
      mode: 'manual',
      supportedEndpoints: ['responses'],
      preferredEndpoint: 'responses',
      updatedAtMs: Date.now(),
    });
    await recordCheckinSiteResolution(site.id, {
      code: 'upstream_error',
      category: 'site',
      title: '上游站点错误',
      actionHint: '稍后重试',
      detailHint: 'test',
      lifecycle: 'failed',
      normalizedStatus: 'failed',
      checkinSnapshotStatus: 'retryable_failed',
      retryable: true,
      requiresManual: false,
      unsupported: false,
      advanceLastCheckinAt: false,
      refreshBalance: false,
      healthState: 'unhealthy',
      logMessage: 'site upstream error',
      eventLevel: 'error',
    });

    recordUpstreamEndpointFailure({
      siteId: site.id,
      accountId: account.id,
      accountAccessToken: account.accessToken,
      accountApiToken: account.apiToken,
      siteApiKey: site.apiKey,
      endpoint: 'chat',
      downstreamFormat: 'responses',
      status: 400,
      errorText: 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.',
      modelName: 'gpt-4o-mini',
    });

    openModelCircuitImmediately(channel.id, 'gpt-4o-mini', 'model_unsupported');
    await tokenRouter.recordFailure(channel.id, {
      modelName: 'gpt-4o-mini',
      status: 503,
      errorText: 'service unavailable',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/routes/diagnostics?limit=50',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      routeSummary: { routeCount: number; channelCount: number };
      endpointRuntimeMemory: { total: number };
      persistedEndpointProfiles: { total: number };
      modelCircuits: { total: number; openCount: number };
      siteRuntimeHealth: { total: number };
      accountRuntimeHealth: {
        total: number;
        busyCount: number;
        stickyActiveCount: number;
        items: Array<{ accountId: number; successEma: number; inflightCount: number; concurrencyBudget: number }>;
      };
      unavailableModels: { total: number; blockingCount: number };
      checkinSiteRuntime: {
        total: number;
        blockedCount: number;
        items: Array<{ siteId: number; blocked: boolean; failureStreak: number; lastReasonCode: string | null }>;
      };
      siteProfiles: { total: number; manualConfiguredCount: number };
      checkinTodo: {
        attentionCount: number;
        manualRequiredCount: number;
        siteBackoffBlockedCount: number;
        sites: Array<{
          siteId: number;
          attentionCount: number;
          siteBackoffBlocked: boolean;
          siteBackoffFailureStreak: number;
          siteBackoffReasonCode: string | null;
          sampleAccounts: Array<{ checkinSnapshot?: { status?: string; reasonCode?: string } | null }>;
        }>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.routeSummary.routeCount).toBe(1);
    expect(body.routeSummary.channelCount).toBe(1);
    expect(body.endpointRuntimeMemory.total).toBeGreaterThanOrEqual(1);
    expect(body.endpointRuntimeMemory.items?.[0]?.preferredReason).toBe('suggested');
    expect(body.endpointRuntimeMemory.items?.[0]?.lastProbeStatus).toBe('failed');
    expect(body.endpointRuntimeMemory.items?.[0]?.probeAfter).toBeTruthy();
    expect(body.persistedEndpointProfiles.total).toBeGreaterThanOrEqual(1);
    expect(body.persistedEndpointProfiles.items?.[0]?.preferredReason).toBe('suggested');
    expect(body.persistedEndpointProfiles.items?.[0]?.lastProbeStatus).toBe('failed');
    expect(body.persistedEndpointProfiles.items?.[0]?.probeAfter).toBeTruthy();
    expect(body.modelCircuits.total).toBeGreaterThanOrEqual(1);
    expect(body.modelCircuits.openCount).toBeGreaterThanOrEqual(1);
    expect(body.siteRuntimeHealth.total).toBeGreaterThanOrEqual(1);
    expect(body.accountRuntimeHealth.total).toBeGreaterThanOrEqual(1);
    expect(body.accountRuntimeHealth.items[0]?.accountId).toBe(account.id);
    expect(body.accountRuntimeHealth.items[0]?.successEma).toBeGreaterThanOrEqual(0);
    expect(body.unavailableModels.total).toBeGreaterThanOrEqual(1);
    expect(body.unavailableModels.blockingCount).toBeGreaterThanOrEqual(1);
    expect(body.checkinSiteRuntime.total).toBeGreaterThanOrEqual(1);
    expect(body.checkinSiteRuntime.blockedCount).toBeGreaterThanOrEqual(1);
    expect(body.checkinSiteRuntime.items[0]?.siteId).toBe(site.id);
    expect(body.checkinSiteRuntime.items[0]?.failureStreak).toBeGreaterThanOrEqual(1);
    expect(body.checkinSiteRuntime.items[0]?.lastReasonCode).toBe('upstream_error');
    expect(body.siteProfiles.total).toBeGreaterThanOrEqual(1);
    expect(body.siteProfiles.manualConfiguredCount).toBeGreaterThanOrEqual(1);
    expect(body.checkinTodo.attentionCount).toBeGreaterThanOrEqual(1);
    expect(body.checkinTodo.manualRequiredCount).toBeGreaterThanOrEqual(1);
    expect(body.checkinTodo.siteBackoffBlockedCount).toBeGreaterThanOrEqual(1);
    expect(body.checkinTodo.sites.some((item) => item.siteId === site.id && item.attentionCount > 0)).toBe(true);
    expect(body.checkinTodo.sites[0]?.siteBackoffBlocked).toBe(true);
    expect(body.checkinTodo.sites[0]?.siteBackoffFailureStreak).toBeGreaterThanOrEqual(1);
    expect(body.checkinTodo.sites[0]?.siteBackoffReasonCode).toBe('upstream_error');
    expect(body.checkinTodo.sites[0]?.sampleAccounts[0]?.checkinSnapshot?.status).toBe('manual_required');
    expect(body.checkinTodo.sites[0]?.sampleAccounts[0]?.checkinSnapshot?.reasonCode).toBe('manual_turnstile_required');
  });

  it('returns lightweight overview and can trigger a governance recovery pass', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'overview-site',
      url: 'https://overview-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'overview-user',
      accessToken: 'overview-access',
      apiToken: 'sk-overview',
      status: 'active',
      checkinEnabled: true,
      extraConfig: JSON.stringify({
        checkinSnapshot: {
          version: 1,
          status: 'manual_required',
          reasonCode: 'manual_turnstile_required',
          retryable: false,
          requiresManual: true,
          unsupported: false,
          lastAttemptAt: '2026-03-25T00:00:00.000Z',
          message: 'manual required',
          source: 'checkin',
        },
      }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-overview',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-overview',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'gpt-overview',
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    await upsertRoutingGovernanceState({
      subjectType: 'token',
      subjectId: token.id,
      state: 'suppressed',
      reasonCode: 'auth',
      reasonDetail: 'token expired',
      suppressUntil: '2000-01-01T00:00:00.000Z',
      probeAfter: '2000-01-01T00:00:00.000Z',
      lastFailureAt: '2026-03-25T00:00:00.000Z',
    });

    const overviewResponse = await app.inject({
      method: 'GET',
      url: '/api/routes/overview',
    });

    expect(overviewResponse.statusCode).toBe(200);
    expect(overviewResponse.json()).toMatchObject({
      success: true,
      routeSummary: {
        routeCount: 1,
        enabledRouteCount: 1,
        channelCount: 1,
        enabledChannelCount: 1,
      },
      governance: {
        total: 1,
        suppressed: 1,
        probing: 0,
      },
      runtime: {
        checkinAttention: 1,
      },
    });

    const recoveryResponse = await app.inject({
      method: 'POST',
      url: '/api/routes/governance/recovery-pass',
      payload: {},
    });

    expect(recoveryResponse.statusCode).toBe(200);
    expect(recoveryResponse.json()).toMatchObject({
      success: true,
      scanned: 1,
      promotedToProbing: 0,
      restored: 1,
    });

    const subjectsResponse = await app.inject({
      method: 'GET',
      url: '/api/routes/governance/subjects',
    });
    expect(subjectsResponse.statusCode).toBe(200);
    expect(subjectsResponse.json()).toMatchObject({
      success: true,
      total: 0,
      items: [],
    });
  });

  it('keeps manual-required attention without marking site runtime backoff', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'manual-only-site',
      url: 'https://manual-only.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'manual-only-user',
      accessToken: 'manual-token',
      status: 'active',
      checkinEnabled: true,
      extraConfig: JSON.stringify({
        checkinSnapshot: {
          version: 1,
          status: 'manual_required',
          reasonCode: 'manual_turnstile_required',
          retryable: false,
          requiresManual: true,
          unsupported: false,
          lastAttemptAt: '2026-03-25T00:00:00.000Z',
          message: '站点开启了 Turnstile 校验，需要人工签到',
          source: 'checkin',
        },
      }),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/routes/diagnostics?limit=20',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      checkinSiteRuntime: { total: number; blockedCount: number };
      checkinTodo: {
        attentionCount: number;
        manualRequiredCount: number;
        siteBackoffBlockedCount: number;
        sites: Array<{ siteId: number; siteBackoffBlocked: boolean; sampleAccounts: Array<{ checkinSnapshot?: { status?: string } | null }> }>;
      };
    };

    expect(body.checkinSiteRuntime.total).toBe(0);
    expect(body.checkinSiteRuntime.blockedCount).toBe(0);
    expect(body.checkinTodo.attentionCount).toBeGreaterThanOrEqual(1);
    expect(body.checkinTodo.manualRequiredCount).toBeGreaterThanOrEqual(1);
    expect(body.checkinTodo.siteBackoffBlockedCount).toBe(0);
    expect(body.checkinTodo.sites[0]?.siteId).toBe(site.id);
    expect(body.checkinTodo.sites[0]?.siteBackoffBlocked).toBe(false);
    expect(body.checkinTodo.sites[0]?.sampleAccounts[0]?.checkinSnapshot?.status).toBe('manual_required');
  });

  it('maps governance subjects to diagnostic targets for direct and channel subjects', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'governance-map-site',
      url: 'https://governance-map.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'governance-map-user',
      accessToken: 'governance-map-access',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'governance-default',
      token: 'sk-governance-default',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-governance-map',
      enabled: true,
    }).returning().get();

    const channelWithToken = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'gpt-governance-map',
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const channelWithoutToken = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: 'gpt-governance-map-account-only',
      priority: 1,
      weight: 5,
      enabled: true,
    }).returning().get();

    await upsertRoutingGovernanceState({
      subjectType: 'site',
      subjectId: site.id,
      reasonCode: 'slow_site',
      reasonDetail: 'site degraded',
      suppressUntil: '2099-01-01T00:00:00.000Z',
    });
    await upsertRoutingGovernanceState({
      subjectType: 'account',
      subjectId: account.id,
      reasonCode: 'auth',
      reasonDetail: 'account auth failed',
      suppressUntil: '2099-01-01T00:00:00.000Z',
    });
    await upsertRoutingGovernanceState({
      subjectType: 'token',
      subjectId: token.id,
      reasonCode: 'auth',
      reasonDetail: 'token auth failed',
      suppressUntil: '2099-01-01T00:00:00.000Z',
    });
    await upsertRoutingGovernanceState({
      subjectType: 'channel',
      subjectId: channelWithToken.id,
      reasonCode: 'model_unsupported',
      reasonDetail: 'channel token unsupported',
      suppressUntil: '2099-01-01T00:00:00.000Z',
    });
    await upsertRoutingGovernanceState({
      subjectType: 'channel',
      subjectId: channelWithoutToken.id,
      reasonCode: 'invalid_channel',
      reasonDetail: 'channel missing token',
      suppressUntil: '2099-01-01T00:00:00.000Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/routes/governance/subjects?limit=20',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      total: number;
      items: Array<{
        subjectType: 'site' | 'account' | 'token' | 'channel';
        subjectId: number;
        diagnosticTargetType?: 'site' | 'account' | 'token';
        diagnosticTargetId: number | null;
      }>;
    };

    expect(body.success).toBe(true);
    expect(body.total).toBe(5);
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subjectType: 'site',
        subjectId: site.id,
        diagnosticTargetType: 'site',
        diagnosticTargetId: site.id,
      }),
      expect.objectContaining({
        subjectType: 'account',
        subjectId: account.id,
        diagnosticTargetType: 'account',
        diagnosticTargetId: account.id,
      }),
      expect.objectContaining({
        subjectType: 'token',
        subjectId: token.id,
        diagnosticTargetType: 'token',
        diagnosticTargetId: token.id,
      }),
      expect.objectContaining({
        subjectType: 'channel',
        subjectId: channelWithToken.id,
        diagnosticTargetType: 'token',
        diagnosticTargetId: token.id,
      }),
      expect.objectContaining({
        subjectType: 'channel',
        subjectId: channelWithoutToken.id,
        diagnosticTargetType: 'account',
        diagnosticTargetId: account.id,
      }),
    ]));
  });

  it('probes route channels and writes governance suppression for unavailable tokens', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'probe-site',
      url: 'https://probe-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'probe-user',
      accessToken: 'probe-access',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-probe-token',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4.1',
      probePolicy: 'manual',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'gpt-4.1',
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      checkedAt: new Date().toISOString(),
    }).run();

    getModelsMock.mockResolvedValue(['gpt-4o']);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'model gpt-4.1 not found' },
    }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/probe`,
      payload: { limit: 20, autoGovernance: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      total: number;
      availableCount: number;
      unavailableCount: number;
      failedCount: number;
      items: Array<{
        available: boolean;
        governanceAction: string;
        governanceReasonCode: string | null;
      }>;
    };
    expect(body.total).toBe(1);
    expect(body.availableCount).toBe(0);
    expect(body.unavailableCount).toBe(1);
    expect(body.failedCount).toBe(0);
    expect(body.items[0]).toMatchObject({
      available: false,
      governanceAction: 'suppressed',
      governanceReasonCode: 'model_unsupported',
    });

    const governance = await db.select().from(schema.routingGovernanceStates).all();
    expect(governance).toHaveLength(1);
    expect(governance[0]).toMatchObject({
      subjectType: 'token',
      subjectId: token.id,
      modelName: 'gpt-4.1',
      reasonCode: 'model_unsupported',
      state: 'suppressed',
    });
    expect(governance[0]?.reasonDetail || '').toContain('[manual_route_probe]');
  });

  it('clears matching governance entries when a probed route channel becomes available again', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'restore-site',
      url: 'https://restore-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'restore-user',
      accessToken: 'restore-access',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'restore-token',
      token: 'sk-restore-token',
      enabled: true,
      isDefault: true,
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
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      checkedAt: new Date().toISOString(),
    }).run();

    await upsertRoutingGovernanceState({
      subjectType: 'token',
      subjectId: token.id,
      modelName: 'gpt-4.1',
      state: 'suppressed',
      reasonCode: 'model_unsupported',
      reasonDetail: 'old failure',
      suppressUntil: new Date(Date.now() + 60_000).toISOString(),
      probeAfter: new Date(Date.now() + 60_000).toISOString(),
      lastFailureAt: new Date().toISOString(),
    });

    getModelsMock.mockResolvedValue(['gpt-4.1']);

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/probe`,
      payload: { limit: 20, autoGovernance: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      availableCount: number;
      items: Array<{
        available: boolean;
        governanceAction: string;
      }>;
    };
    expect(body.availableCount).toBe(1);
    expect(body.items[0]).toMatchObject({
      available: true,
      governanceAction: 'cleared',
    });

    const governance = await db.select().from(schema.routingGovernanceStates).all();
    expect(governance).toHaveLength(0);
  });
});
