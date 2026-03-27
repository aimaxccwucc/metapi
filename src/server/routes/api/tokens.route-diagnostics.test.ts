import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');
type ModelCircuitModule = typeof import('../../services/modelCircuitBreaker.js');
type UpstreamEndpointModule = typeof import('../proxy/upstreamEndpoint.js');
type SiteProtocolConfigModule = typeof import('../../services/siteProtocolConfigService.js');
type UpstreamProtocolProfileModule = typeof import('../../services/upstreamProtocolProfile.js');
type CheckinSiteRuntimeModule = typeof import('../../services/checkinSiteRuntime.js');

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

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
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
    expect(body.persistedEndpointProfiles.total).toBeGreaterThanOrEqual(1);
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
});
