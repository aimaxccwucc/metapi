import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

describe('TokenRouter runtime cache', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let flushSiteRuntimeHealthPersistence: TokenRouterModule['flushSiteRuntimeHealthPersistence'];
  let listAccountRoutingRuntimeSnapshots: TokenRouterModule['listAccountRoutingRuntimeSnapshots'];
  let reportTokenExpired: typeof import('./alertService.js')['reportTokenExpired'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalCacheTtlMs = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-cache-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const alertServiceModule = await import('./alertService.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    flushSiteRuntimeHealthPersistence = tokenRouterModule.flushSiteRuntimeHealthPersistence;
    listAccountRoutingRuntimeSnapshots = tokenRouterModule.listAccountRoutingRuntimeSnapshots;
    reportTokenExpired = alertServiceModule.reportTokenExpired;
    config = configModule.config;
    originalCacheTtlMs = config.tokenRouterCacheTtlMs;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    config.tokenRouterCacheTtlMs = 60_000;
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
  });

  afterAll(() => {
    config.tokenRouterCacheTtlMs = originalCacheTtlMs;
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    delete process.env.DATA_DIR;
  });

  it('keeps route snapshot inside TTL until explicit invalidation', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cache-site',
      url: 'https://cache-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cache-user',
      accessToken: 'cache-access-token',
      apiToken: 'cache-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'cache-token',
      token: 'sk-cache-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const router = new TokenRouter();
    expect(await router.selectChannel('gpt-4o-mini')).toBeTruthy();

    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.routeId, route.id)).run();
    await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, route.id)).run();

    const cachedSelection = await router.selectChannel('gpt-4o-mini');
    expect(cachedSelection).toBeTruthy();

    invalidateTokenRouterCache();
    const refreshedSelection = await router.selectChannel('gpt-4o-mini');
    expect(refreshedSelection).toBeNull();
  });

  it('clears cached selection immediately after token expiration is reported', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'expired-cache-site',
      url: 'https://expired-cache-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'expired-cache-user',
      accessToken: 'expired-cache-access-token',
      apiToken: 'expired-cache-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'expired-cache-token',
      token: 'sk-expired-cache-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-expired-mini',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const router = new TokenRouter();
    const cachedSelection = await router.selectChannel('gpt-expired-mini');
    expect(cachedSelection?.account.id).toBe(account.id);

    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.routeId, route.id)).run();
    await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, route.id)).run();

    await reportTokenExpired({
      accountId: account.id,
      username: account.username,
      siteName: site.name,
      detail: '401 unauthorized',
    });

    const refreshedSelection = await router.selectChannel('gpt-expired-mini');
    expect(refreshedSelection).toBeNull();

    const storedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(storedAccount?.status).toBe('expired');
  });

  it('restores persisted account rate budget after runtime reset and reloads it in a new router instance', async () => {
    const primarySite = await db.insert(schema.sites).values({
      name: 'account-budget-primary-site',
      url: 'https://account-budget-primary-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const primaryAccount = await db.insert(schema.accounts).values({
      siteId: primarySite.id,
      username: 'account-budget-primary-user',
      accessToken: 'account-budget-primary-access-token',
      apiToken: 'account-budget-primary-api-token',
      status: 'active',
    }).returning().get();

    const primaryToken = await db.insert(schema.accountTokens).values({
      accountId: primaryAccount.id,
      name: 'account-budget-primary-token',
      token: 'sk-account-budget-primary-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const fallbackSite = await db.insert(schema.sites).values({
      name: 'account-budget-fallback-site',
      url: 'https://account-budget-fallback-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const fallbackAccount = await db.insert(schema.accounts).values({
      siteId: fallbackSite.id,
      username: 'account-budget-fallback-user',
      accessToken: 'account-budget-fallback-access-token',
      apiToken: 'account-budget-fallback-api-token',
      status: 'active',
    }).returning().get();

    const fallbackToken = await db.insert(schema.accountTokens).values({
      accountId: fallbackAccount.id,
      name: 'account-budget-fallback-token',
      token: 'sk-account-budget-fallback-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-account-budget-persist',
      enabled: true,
    }).returning().get();

    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: primaryAccount.id,
      tokenId: primaryToken.id,
      priority: 0,
      weight: 20,
      enabled: true,
    }).returning().get();

    const fallbackChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: fallbackAccount.id,
      tokenId: fallbackToken.id,
      priority: 0,
      weight: 5,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const first = await router.selectChannel('gpt-account-budget-persist');
      expect(first?.channel.id).toBe(primaryChannel.id);
      await router.recordSuccess(primaryChannel.id, 320, 0, 'gpt-account-budget-persist');

      await router.recordFailure(primaryChannel.id, {
        status: 429,
        errorText: 'rate limit exceeded',
        modelName: 'gpt-account-budget-persist',
      });
      await db.update(schema.routeChannels).set({
        cooldownUntil: null,
        lastFailAt: null,
        failCount: 0,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      }).where(eq(schema.routeChannels.id, primaryChannel.id)).run();
      invalidateTokenRouterCache();

      const beforeFlush = (await listAccountRoutingRuntimeSnapshots())
        .find((item) => item.accountId === primaryAccount.id);
      expect(beforeFlush?.successEma || 0).toBeGreaterThan(0);
      expect(beforeFlush?.rateLimited).toBe(true);
      expect(beforeFlush?.rateLimitedUntilMs || 0).toBeGreaterThan(Date.now());

      await flushSiteRuntimeHealthPersistence();

      const persistedKeys = new Set((await db.select({ key: schema.settings.key }).from(schema.settings).all())
        .map((row) => row.key));
      expect(persistedKeys.has('token_router_account_health_v1')).toBe(true);
      expect(persistedKeys.has('token_router_account_budget_v1')).toBe(true);

      resetSiteRuntimeHealthState();
      invalidateTokenRouterCache();

      const reloadedRouter = new TokenRouter();
      const afterReload = (await listAccountRoutingRuntimeSnapshots())
        .find((item) => item.accountId === primaryAccount.id);
      expect(afterReload?.successEma || 0).toBeGreaterThan(0);
      expect(afterReload?.rateLimited).toBe(true);

      const preview = await reloadedRouter.previewSelectedChannel('gpt-account-budget-persist');
      expect(preview?.channel.id).toBe(fallbackChannel.id);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('uses category-aware cooldown across repeated failures', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cooldown-site',
      url: 'https://cooldown-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cooldown-user',
      accessToken: 'cooldown-access-token',
      apiToken: 'cooldown-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'cooldown-token',
      token: 'sk-cooldown-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      routingStrategy: 'weighted',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();

    const firstStartedAt = Date.now();
    await router.recordFailure(channel.id);
    const firstRecord = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    const firstCooldownMs = Date.parse(String(firstRecord?.cooldownUntil || '')) - firstStartedAt;
    expect(firstCooldownMs).toBeGreaterThanOrEqual(10_000);
    expect(firstCooldownMs).toBeLessThanOrEqual(20_000);
    expect(firstRecord?.consecutiveFailCount).toBe(1);
    expect(firstRecord?.cooldownLevel).toBe(0);

    const secondStartedAt = Date.now();
    await router.recordFailure(channel.id);
    const secondRecord = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    const secondCooldownMs = Date.parse(String(secondRecord?.cooldownUntil || '')) - secondStartedAt;
    expect(secondCooldownMs).toBeGreaterThanOrEqual(10_000);
    expect(secondCooldownMs).toBeLessThanOrEqual(20_000);
    expect(secondRecord?.consecutiveFailCount).toBe(2);
    expect(secondRecord?.cooldownLevel).toBe(1);

    const thirdStartedAt = Date.now();
    await router.recordFailure(channel.id);
    const thirdRecord = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    const thirdCooldownMs = Date.parse(String(thirdRecord?.cooldownUntil || '')) - thirdStartedAt;
    expect(thirdCooldownMs).toBeGreaterThanOrEqual(25_000);
    expect(thirdCooldownMs).toBeLessThanOrEqual(40_000);
    expect(thirdRecord?.consecutiveFailCount).toBe(3);
    expect(thirdRecord?.cooldownLevel).toBe(1);
  });

  it('extends weighted cooldowns for timeout, ssl 525, upstream group empty, empty-content, and 554 failures', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'extended-cooldown-site',
      url: 'https://extended-cooldown-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'extended-cooldown-user',
      accessToken: 'extended-cooldown-access-token',
      apiToken: 'extended-cooldown-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'extended-cooldown-token',
      token: 'sk-extended-cooldown-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini-extended-cooldown',
      routingStrategy: 'weighted',
      enabled: true,
    }).returning().get();

    const makeChannel = async (weight: number) => (
      db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: account.id,
        tokenId: token.id,
        priority: 0,
        weight,
        enabled: true,
      }).returning().get()
    );

    const timeoutChannel = await makeChannel(10);
    const sslChannel = await makeChannel(11);
    const groupEmptyChannel = await makeChannel(12);
    const emptyContentChannel = await makeChannel(13);
    const http554Channel = await makeChannel(14);
    const router = new TokenRouter();

    let startedAt = Date.now();
    await router.recordFailure(timeoutChannel.id, {
      status: 0,
      errorText: 'upstream timeout after 10000ms',
      modelName: 'gpt-4o-mini-extended-cooldown',
    });
    let record = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, timeoutChannel.id))
      .get();
    let cooldownMs = Date.parse(String(record?.cooldownUntil || '')) - startedAt;
    expect(cooldownMs).toBeGreaterThanOrEqual(19 * 60 * 1000);
    expect(cooldownMs).toBeLessThanOrEqual(21 * 60 * 1000);

    startedAt = Date.now();
    await router.recordFailure(sslChannel.id, {
      status: 525,
      errorText: 'Cloudflare 525: SSL handshake failed',
      modelName: 'gpt-4o-mini-extended-cooldown',
    });
    record = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, sslChannel.id))
      .get();
    cooldownMs = Date.parse(String(record?.cooldownUntil || '')) - startedAt;
    expect(cooldownMs).toBeGreaterThanOrEqual(24 * 60 * 1000);
    expect(cooldownMs).toBeLessThanOrEqual(26 * 60 * 1000);

    startedAt = Date.now();
    await router.recordFailure(groupEmptyChannel.id, {
      status: 503,
      errorText: 'No available providers (cch_session_id: sess_123)',
      modelName: 'gpt-4o-mini-extended-cooldown',
    });
    record = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, groupEmptyChannel.id))
      .get();
    cooldownMs = Date.parse(String(record?.cooldownUntil || '')) - startedAt;
    expect(cooldownMs).toBeGreaterThanOrEqual(19 * 60 * 1000);

    startedAt = Date.now();
    await router.recordFailure(emptyContentChannel.id, {
      status: 502,
      errorText: 'Upstream returned empty content',
      modelName: 'gpt-4o-mini-extended-cooldown',
    });
    record = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, emptyContentChannel.id))
      .get();
    cooldownMs = Date.parse(String(record?.cooldownUntil || '')) - startedAt;
    expect(cooldownMs).toBeGreaterThanOrEqual(9 * 60 * 1000);
    expect(cooldownMs).toBeLessThanOrEqual(11 * 60 * 1000);

    startedAt = Date.now();
    await router.recordFailure(http554Channel.id, {
      status: 554,
      errorText: 'Upstream returned HTTP 554',
      modelName: 'gpt-4o-mini-extended-cooldown',
    });
    record = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, http554Channel.id))
      .get();
    cooldownMs = Date.parse(String(record?.cooldownUntil || '')) - startedAt;
    expect(cooldownMs).toBeGreaterThanOrEqual(19 * 60 * 1000);
    expect(cooldownMs).toBeLessThanOrEqual(21 * 60 * 1000);
  });

  it('round robins across all available channels regardless of priority', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'round-robin-site',
      url: 'https://round-robin-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'round-robin-user',
      accessToken: 'round-robin-access-token',
      apiToken: 'round-robin-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'round-robin-token',
      token: 'sk-round-robin-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      routingStrategy: 'round_robin',
      enabled: true,
    }).returning().get();

    const channels = await db.insert(schema.routeChannels).values([
      { routeId: route.id, accountId: account.id, tokenId: token.id, priority: 0, weight: 10, enabled: true },
      { routeId: route.id, accountId: account.id, tokenId: token.id, priority: 3, weight: 10, enabled: true },
      { routeId: route.id, accountId: account.id, tokenId: token.id, priority: 9, weight: 10, enabled: true },
    ]).returning().all();

    const router = new TokenRouter();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const first = await router.selectChannel('gpt-4o-mini');
      await router.recordSuccess(first!.channel.id, 320, 0, 'gpt-4o-mini');
      await vi.advanceTimersByTimeAsync(1_000);

      const second = await router.selectChannel('gpt-4o-mini');
      await router.recordSuccess(second!.channel.id, 330, 0, 'gpt-4o-mini');
      await vi.advanceTimersByTimeAsync(1_000);

      const third = await router.selectChannel('gpt-4o-mini');
      await router.recordSuccess(third!.channel.id, 340, 0, 'gpt-4o-mini');
      await vi.advanceTimersByTimeAsync(1_000);

      const fourth = await router.selectChannel('gpt-4o-mini');

      expect(first?.channel.id).toBe(channels[0].id);
      expect(second?.channel.id).toBe(channels[1].id);
      expect(third?.channel.id).toBe(channels[2].id);
      expect(fourth?.channel.id).toBe(channels[0].id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies staged cooldowns for round robin after every three consecutive failures', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'round-robin-cooldown-site',
      url: 'https://round-robin-cooldown-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'round-robin-cooldown-user',
      accessToken: 'round-robin-cooldown-access-token',
      apiToken: 'round-robin-cooldown-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'round-robin-cooldown-token',
      token: 'sk-round-robin-cooldown-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      routingStrategy: 'round_robin',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();

    for (let index = 0; index < 2; index += 1) {
      await router.recordFailure(channel.id);
    }
    let current = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(current?.cooldownUntil).toBeNull();
    expect(current?.consecutiveFailCount).toBe(2);
    expect(current?.cooldownLevel).toBe(0);

    let startedAt = Date.now();
    await router.recordFailure(channel.id);
    current = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    let cooldownMs = Date.parse(String(current?.cooldownUntil || '')) - startedAt;
    expect(current?.consecutiveFailCount).toBe(0);
    expect(current?.cooldownLevel).toBe(1);
    expect(cooldownMs).toBeGreaterThanOrEqual(9 * 60 * 1000);
    expect(cooldownMs).toBeLessThanOrEqual(11 * 60 * 1000);

    await db.update(schema.routeChannels).set({ cooldownUntil: null }).where(eq(schema.routeChannels.id, channel.id)).run();

    for (let index = 0; index < 2; index += 1) {
      await router.recordFailure(channel.id);
    }
    startedAt = Date.now();
    await router.recordFailure(channel.id);
    current = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    cooldownMs = Date.parse(String(current?.cooldownUntil || '')) - startedAt;
    expect(current?.cooldownLevel).toBe(2);
    expect(cooldownMs).toBeGreaterThanOrEqual(59 * 60 * 1000);
    expect(cooldownMs).toBeLessThanOrEqual(61 * 60 * 1000);

    await db.update(schema.routeChannels).set({ cooldownUntil: null }).where(eq(schema.routeChannels.id, channel.id)).run();

    for (let index = 0; index < 2; index += 1) {
      await router.recordFailure(channel.id);
    }
    startedAt = Date.now();
    await router.recordFailure(channel.id);
    current = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    cooldownMs = Date.parse(String(current?.cooldownUntil || '')) - startedAt;
    expect(current?.cooldownLevel).toBe(3);
    expect(cooldownMs).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
    expect(cooldownMs).toBeLessThanOrEqual(25 * 60 * 60 * 1000);

    await router.recordSuccess(channel.id, 320, 0.12);
    current = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(current?.consecutiveFailCount).toBe(0);
    expect(current?.cooldownLevel).toBe(0);
    expect(current?.cooldownUntil).toBeNull();
  });

  it('applies immediate cooldown for auth-like failures under round robin', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'round-robin-auth-site',
      url: 'https://round-robin-auth-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'round-robin-auth-user',
      accessToken: 'round-robin-auth-access-token',
      apiToken: 'round-robin-auth-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'round-robin-auth-token',
      token: 'sk-round-robin-auth-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-auth-round-robin',
      routingStrategy: 'round_robin',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const startedAt = Date.now();
    await router.recordFailure(channel.id, {
      status: 401,
      errorText: 'invalid api key',
      modelName: 'gpt-4o-auth-round-robin',
    });

    const current = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    const cooldownMs = Date.parse(String(current?.cooldownUntil || '')) - startedAt;

    expect(current?.consecutiveFailCount).toBe(1);
    expect(current?.cooldownLevel).toBe(3);
    expect(cooldownMs).toBeGreaterThanOrEqual(29 * 60 * 1000);
    expect(cooldownMs).toBeLessThanOrEqual(31 * 60 * 1000);
  });

  it('skips recently failed round-robin channels before recycling them', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'round-robin-recent-failure-site',
      url: 'https://round-robin-recent-failure-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'round-robin-recent-failure-user',
      accessToken: 'round-robin-recent-failure-access-token',
      apiToken: 'round-robin-recent-failure-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'round-robin-recent-failure-token',
      token: 'sk-round-robin-recent-failure-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-round-robin-recent-failure',
      routingStrategy: 'round_robin',
      enabled: true,
    }).returning().get();

    const channels = await db.insert(schema.routeChannels).values([
      { routeId: route.id, accountId: account.id, tokenId: token.id, priority: 0, weight: 10, enabled: true },
      { routeId: route.id, accountId: account.id, tokenId: token.id, priority: 5, weight: 10, enabled: true },
    ]).returning().all();

    const router = new TokenRouter();
    await router.recordFailure(channels[0].id, {
      status: 503,
      errorText: 'service unavailable',
      modelName: 'gpt-4o-round-robin-recent-failure',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
    }).where(eq(schema.routeChannels.id, channels[0].id)).run();
    invalidateTokenRouterCache();

    const selected = await router.previewSelectedChannel('gpt-4o-round-robin-recent-failure');

    expect(selected?.channel.id).toBe(channels[1].id);
  });

  it('persists and reloads account runtime budget snapshots after reset', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'persist-budget-site',
      url: 'https://persist-budget-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'persist-budget-user',
      accessToken: 'persist-budget-access-token',
      apiToken: 'persist-budget-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'persist-budget-token',
      token: 'sk-persist-budget-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-persist-budget',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const nowMs = Date.now();
    await db.insert(schema.settings).values({
      key: 'token_router_account_budget_v1',
      value: JSON.stringify({
        version: 1,
        savedAtMs: nowMs,
        byAccountId: {
          [String(account.id)]: {
            budget: {
              tokens: 0.25,
              capacity: 2,
              refillPerSec: 0.6,
              lastRefillAtMs: nowMs,
              lastGrantedAtMs: null,
              denyUntilMs: nowMs + 30_000,
              updatedAtMs: nowMs,
            },
            inflightLeases: [],
          },
        },
      }),
    }).run();

    resetSiteRuntimeHealthState();
    invalidateTokenRouterCache();

    const persistedBudget = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'token_router_account_budget_v1'))
      .get();
    expect(persistedBudget?.value).toContain(`"${account.id}"`);

    const beforeReset = await listAccountRoutingRuntimeSnapshots();
    const snapshotBeforeReset = beforeReset.find((item) => item.accountId === account.id);
    expect(snapshotBeforeReset?.rateLimited).toBe(true);
    expect(snapshotBeforeReset?.rateLimitedUntilMs || 0).toBeGreaterThan(Date.now());

    resetSiteRuntimeHealthState();
    invalidateTokenRouterCache();

    const afterReset = await listAccountRoutingRuntimeSnapshots();
    const restoredSnapshot = afterReset.find((item) => item.accountId === account.id);
    expect(restoredSnapshot?.rateLimited).toBe(true);
    expect(restoredSnapshot?.rateLimitCapacity || 0).toBeGreaterThan(0);
  });
});
