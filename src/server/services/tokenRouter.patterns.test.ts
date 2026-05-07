import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ModelCircuitBreakerModule = typeof import('./modelCircuitBreaker.js');

describe('TokenRouter patterns and model mapping', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let resetAllModelCircuits: ModelCircuitBreakerModule['resetAllModelCircuits'];
  let dataDir = '';
  let idSeed = 0;

  const nextId = () => {
    idSeed += 1;
    return idSeed;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-patterns-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const modelCircuitBreakerModule = await import('./modelCircuitBreaker.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    resetAllModelCircuits = modelCircuitBreakerModule.resetAllModelCircuits;
  });

  beforeEach(async () => {
    idSeed = 0;
    await db.delete(schema.settings).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    resetAllModelCircuits();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    resetAllModelCircuits();
    delete process.env.DATA_DIR;
  });

  async function createSite(namePrefix: string) {
    const id = nextId();
    return await db.insert(schema.sites).values({
      name: `${namePrefix}-${id}`,
      url: `https://${namePrefix}-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
  }

  async function createAccount(siteId: number, usernamePrefix: string) {
    const id = nextId();
    return await db.insert(schema.accounts).values({
      siteId,
      username: `${usernamePrefix}-${id}`,
      accessToken: `access-${id}`,
      apiToken: `sk-${id}`,
      status: 'active',
    }).returning().get();
  }

  async function createRouteWithSingleChannel(
    modelPattern: string,
    modelMapping?: string,
    options?: { displayName?: string; sourceModel?: string | null; manualOverride?: boolean },
  ) {
    const site = await createSite('pattern-site');
    const account = await createAccount(site.id, 'pattern-user');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      displayName: options?.displayName,
      modelMapping,
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: options?.sourceModel ?? null,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: options?.manualOverride ?? false,
    }).returning().get();
    return { route, channel };
  }

  async function createExplicitGroupRoute(
    displayName: string,
    sourceRouteIds: number[],
  ) {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: displayName,
      displayName,
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeGroupSources).values(
      sourceRouteIds.map((sourceRouteId) => ({
        groupRouteId: route.id,
        sourceRouteId,
      })),
    ).run();

    return route;
  }

  it('matches routes with re: regex patterns', async () => {
    await createRouteWithSingleChannel('re:^claude-(opus|sonnet)-4-6$');
    const router = new TokenRouter();

    const matched = await router.selectChannel('claude-opus-4-6');
    const unmatched = await router.selectChannel('claude-haiku-4-6');

    expect(matched).toBeTruthy();
    expect(matched?.actualModel).toBe('claude-opus-4-6');
    expect(unmatched).toBeNull();
  });

  it('ignores invalid re: patterns and falls back to next matched route', async () => {
    const invalid = await createRouteWithSingleChannel('re:([a-z');
    const glob = await createRouteWithSingleChannel('claude-*');
    const router = new TokenRouter();

    const selected = await router.selectChannel('claude-opus-4-6');
    expect(selected).toBeTruthy();
    expect(selected?.channel.id).toBe(glob.channel.id);
    expect(selected?.channel.id).not.toBe(invalid.channel.id);
  });

  it('supports exact, glob and re: keys in modelMapping with exact taking precedence', async () => {
    const mapping = JSON.stringify({
      'claude-sonnet-4-6': 'target-exact',
      'claude-sonnet-*': 'target-glob',
      're:^gpt-4o-mini-\\d+$': 'target-regex',
    });
    await createRouteWithSingleChannel('*', mapping);
    const router = new TokenRouter();

    const exact = await router.previewSelectedChannel('claude-sonnet-4-6');
    const glob = await router.previewSelectedChannel('claude-sonnet-4-7');
    const regex = await router.previewSelectedChannel('gpt-4o-mini-20250101');

    expect(exact?.actualModel).toBe('target-exact');
    expect(glob?.actualModel).toBe('target-glob');
    expect(regex?.actualModel).toBe('target-regex');
  });

  it('matches a route by display name alias as an exposed model', async () => {
    await createRouteWithSingleChannel(
      're:^claude-(opus|sonnet)-4-5$',
      undefined,
      {
        displayName: 'claude-opus-4-6',
        sourceModel: 'claude-opus-4-5',
      },
    );
    const router = new TokenRouter();

    const selected = await router.selectChannel('claude-opus-4-6');
    const decision = await router.explainSelection('claude-opus-4-6');
    const exposedModels = await router.getAvailableModels();

    expect(selected).toBeTruthy();
    expect(selected?.actualModel).toBe('claude-opus-4-5');
    expect(decision.actualModel).toBe('claude-opus-4-5');
    expect(exposedModels).toContain('claude-opus-4-6');
  });

  it('matches exact routes case-insensitively while preserving routed model casing', async () => {
    await createRouteWithSingleChannel(
      'deepseek-v4-pro',
      undefined,
      {
        sourceModel: 'deepseek-v4-pro',
      },
    );
    const router = new TokenRouter();

    const selected = await router.selectChannel('DeepSeek-V4-Pro');
    const decision = await router.explainSelection('DeepSeek-V4-Pro');

    expect(selected).toBeTruthy();
    expect(selected?.actualModel).toBe('deepseek-v4-pro');
    expect(decision.matched).toBe(true);
    expect(decision.actualModel).toBe('deepseek-v4-pro');
  });

  it('prefers an exact route over a colliding group display-name alias', async () => {
    await createRouteWithSingleChannel(
      're:^claude-(opus|sonnet)-4-5$',
      undefined,
      {
        displayName: 'claude-opus-4-6',
        sourceModel: 'claude-opus-4-5',
      },
    );
    const exact = await createRouteWithSingleChannel(
      'claude-opus-4-6',
      undefined,
      {
        sourceModel: 'claude-opus-4-6',
      },
    );
    const router = new TokenRouter();

    const selected = await router.selectChannel('claude-opus-4-6');
    const decision = await router.explainSelection('claude-opus-4-6');

    expect(selected).toBeTruthy();
    expect(selected?.channel.id).toBe(exact.channel.id);
    expect(selected?.actualModel).toBe('claude-opus-4-6');
    expect(decision.actualModel).toBe('claude-opus-4-6');
  });

  it('allows manually pinned heterogeneous source models on exact routes', async () => {
    const manual = await createRouteWithSingleChannel(
      'gpt-5.5',
      undefined,
      {
        sourceModel: 'glm-5.1',
        manualOverride: true,
      },
    );
    const router = new TokenRouter();

    const selected = await router.selectChannel('gpt-5.5');
    const decision = await router.explainSelection('gpt-5.5');
    const candidate = decision.candidates.find((item) => item.channelId === manual.channel.id);

    expect(selected).toBeTruthy();
    expect(selected?.channel.id).toBe(manual.channel.id);
    expect(selected?.actualModel).toBe('glm-5.1');
    expect(decision.actualModel).toBe('glm-5.1');
    expect(candidate?.eligible).toBe(true);
    expect(candidate?.reason || '').not.toContain('来源模型不匹配');
    expect(decision.summary).toContain('实际转发模型：glm-5.1');
  });

  it('still filters automatically discovered heterogeneous source models on exact routes', async () => {
    const auto = await createRouteWithSingleChannel(
      'gpt-5.5',
      undefined,
      {
        sourceModel: 'glm-5.1',
        manualOverride: false,
      },
    );
    const router = new TokenRouter();

    const decision = await router.explainSelectionForRoute(auto.route.id, 'gpt-5.5');
    const selected = await router.previewSelectedChannel('gpt-5.5');
    const candidate = decision.candidates.find((item) => item.channelId === auto.channel.id);

    expect(selected).toBeNull();
    expect(decision.selectedChannelId).toBeUndefined();
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.reason || '').toContain('来源模型不匹配=glm-5.1');
  });

  it('prefers an explicit-group exposed model over a legacy exact pattern route', async () => {
    const legacy = await createRouteWithSingleChannel(
      'gemini-2.5-pro',
      undefined,
      {
        sourceModel: 'gemini-2.5-pro',
      },
    );
    const stable = await createRouteWithSingleChannel(
      'gemini-2.5-pro-search',
      undefined,
      {
        sourceModel: 'gemini-2.5-pro-search',
      },
    );
    await createExplicitGroupRoute('gemini-2.5-pro', [stable.route.id]);
    const router = new TokenRouter();

    const selected = await router.selectChannel('gemini-2.5-pro');
    const decision = await router.explainSelection('gemini-2.5-pro');

    expect(selected).toBeTruthy();
    expect(selected?.channel.routeId).toBe(stable.route.id);
    expect(selected?.channel.routeId).not.toBe(legacy.route.id);
    expect(selected?.actualModel).toBe('gemini-2.5-pro-search');
    expect(decision.actualModel).toBe('gemini-2.5-pro-search');
    expect(decision.summary).toContain('按显示名命中：gemini-2.5-pro');
  });

  it('falls back to the source exact-route model when explicit-group channels omit sourceModel', async () => {
    const source = await createRouteWithSingleChannel('claude-opus-4-5');
    await createExplicitGroupRoute('claude-test-4.6-sonnet', [source.route.id]);
    const router = new TokenRouter();

    const selected = await router.selectChannel('claude-test-4.6-sonnet');
    const decision = await router.explainSelection('claude-test-4.6-sonnet');

    expect(selected).toBeTruthy();
    expect(selected?.actualModel).toBe('claude-opus-4-5');
    expect(decision.actualModel).toBe('claude-opus-4-5');
    expect(decision.summary).toContain('按显示名命中：claude-test-4.6-sonnet');
    expect(decision.summary).toContain('实际转发模型：claude-opus-4-5');
  });
});
