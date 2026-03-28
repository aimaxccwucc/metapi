import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

const mockedCatalogRoutingCost = vi.fn<(
  input: { siteId: number; accountId: number; modelName: string }
) => number | null>(() => null);

vi.mock('./modelPricingService.js', async () => {
  const actual = await vi.importActual<typeof import('./modelPricingService.js')>('./modelPricingService.js');
  return {
    ...actual,
    getCachedModelRoutingReferenceCost: mockedCatalogRoutingCost,
  };
});

describe('TokenRouter selection scoring', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let listAccountRoutingRuntimeSnapshots: TokenRouterModule['listAccountRoutingRuntimeSnapshots'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let resetAllModelCircuits: typeof import('./modelCircuitBreaker.js')['resetAllModelCircuits'];
  let flushSiteRuntimeHealthPersistence: TokenRouterModule['flushSiteRuntimeHealthPersistence'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let idSeed = 0;
  let originalRoutingWeights: typeof config.routingWeights;
  let originalRoutingFallbackUnitCost: number;

  const nextId = () => {
    idSeed += 1;
    return idSeed;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-selection-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const modelCircuitBreakerModule = await import('./modelCircuitBreaker.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    listAccountRoutingRuntimeSnapshots = tokenRouterModule.listAccountRoutingRuntimeSnapshots;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    resetAllModelCircuits = modelCircuitBreakerModule.resetAllModelCircuits;
    flushSiteRuntimeHealthPersistence = tokenRouterModule.flushSiteRuntimeHealthPersistence;
    config = configModule.config;
    originalRoutingWeights = { ...config.routingWeights };
    originalRoutingFallbackUnitCost = config.routingFallbackUnitCost;
  });

  beforeEach(async () => {
    idSeed = 0;
    mockedCatalogRoutingCost.mockReset();
    mockedCatalogRoutingCost.mockReturnValue(null);
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    resetAllModelCircuits();
  });

  afterAll(() => {
    config.routingWeights = { ...originalRoutingWeights };
    config.routingFallbackUnitCost = originalRoutingFallbackUnitCost;
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    resetAllModelCircuits();
    delete process.env.DATA_DIR;
  });

  async function createRoute(modelPattern: string) {
    return await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();
  }

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

  async function createToken(accountId: number, name: string) {
    return await db.insert(schema.accountTokens).values({
      accountId,
      name,
      token: `token-${name}-${nextId()}`,
      enabled: true,
      isDefault: false,
    }).returning().get();
  }

  it('normalizes probability across channels on the same site', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('claude-haiku-4-5-20251001');

    const siteA = await createSite('site-a');
    const accountA = await createAccount(siteA.id, 'user-a');
    const tokenA1 = await createToken(accountA.id, 'a-1');
    const tokenA2 = await createToken(accountA.id, 'a-2');

    const siteB = await createSite('site-b');
    const accountB = await createAccount(siteB.id, 'user-b');
    const tokenB = await createToken(accountB.id, 'b-1');

    const channelA1 = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA1.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const channelA2 = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA2.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const decision = await new TokenRouter().explainSelection('claude-haiku-4-5-20251001');
    const probMap = new Map(decision.candidates.map((candidate) => [candidate.channelId, candidate.probability]));

    const probA1 = probMap.get(channelA1.id) ?? 0;
    const probA2 = probMap.get(channelA2.id) ?? 0;
    const probB = probMap.get(channelB.id) ?? 0;

    expect(probA1).toBeCloseTo(25, 1);
    expect(probA2).toBeCloseTo(25, 1);
    expect(probB).toBeCloseTo(50, 1);
    expect(probA1 + probA2).toBeCloseTo(probB, 1);
  });

  it('uses observed channel cost from real routing results when scoring cost priority', async () => {
    config.routingWeights = {
      baseWeightFactor: 0.35,
      valueScoreFactor: 0.65,
      costWeight: 1,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('claude-opus-4-6');

    const siteCheap = await createSite('cheap-site');
    const accountCheap = await createAccount(siteCheap.id, 'cheap-user');
    const tokenCheap = await createToken(accountCheap.id, 'cheap-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountCheap.id,
      tokenId: tokenCheap.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 10,
      failCount: 0,
      totalCost: 0.01,
    }).run();

    const siteExpensive = await createSite('expensive-site');
    const accountExpensive = await createAccount(siteExpensive.id, 'expensive-user');
    const tokenExpensive = await createToken(accountExpensive.id, 'exp-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountExpensive.id,
      tokenId: tokenExpensive.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 10,
      failCount: 0,
      totalCost: 0.1,
    }).run();

    const decision = await new TokenRouter().explainSelection('claude-opus-4-6');
    const cheapCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('cheap-site'));
    const expensiveCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('expensive-site'));

    expect(cheapCandidate).toBeTruthy();
    expect(expensiveCandidate).toBeTruthy();
    expect((cheapCandidate?.probability || 0)).toBeGreaterThan(expensiveCandidate?.probability || 0);
    expect(cheapCandidate?.reason || '').toContain('成本=实测');
    expect(expensiveCandidate?.reason || '').toContain('成本=实测');
  });

  it('uses runtime-configured fallback unit cost when observed and configured costs are missing', async () => {
    config.routingWeights = {
      baseWeightFactor: 0.35,
      valueScoreFactor: 0.65,
      costWeight: 1,
      balanceWeight: 0,
      usageWeight: 0,
    };
    config.routingFallbackUnitCost = 0.02;

    const route = await createRoute('claude-sonnet-4-6');

    const siteFallback = await createSite('fallback-site');
    const accountFallback = await createAccount(siteFallback.id, 'fallback-user');
    const tokenFallback = await createToken(accountFallback.id, 'fallback-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 0,
      failCount: 0,
      totalCost: 0,
    }).run();

    const siteObserved = await createSite('observed-site');
    const accountObserved = await createAccount(siteObserved.id, 'observed-user');
    const tokenObserved = await createToken(accountObserved.id, 'observed-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountObserved.id,
      tokenId: tokenObserved.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 10,
      failCount: 0,
      totalCost: 2, // unit cost 0.2
    }).run();

    const decision = await new TokenRouter().explainSelection('claude-sonnet-4-6');
    const fallbackCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('fallback-site'));
    const observedCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('observed-site'));

    expect(fallbackCandidate).toBeTruthy();
    expect(observedCandidate).toBeTruthy();
    expect((fallbackCandidate?.probability || 0)).toBeGreaterThan(observedCandidate?.probability || 0);
    expect(fallbackCandidate?.reason || '').toContain('成本=默认:0.020000');
  });

  it('penalizes fallback-cost channels when fallback unit cost is set very high', async () => {
    config.routingWeights = {
      baseWeightFactor: 0.35,
      valueScoreFactor: 0.65,
      costWeight: 0.75,
      balanceWeight: 0.15,
      usageWeight: 0.1,
    };
    config.routingFallbackUnitCost = 1000;

    const route = await createRoute('gpt-5-nano');

    const siteFallback = await createSite('fallback-high-balance');
    const accountFallback = await db.insert(schema.accounts).values({
      siteId: siteFallback.id,
      username: `fallback-high-balance-${nextId()}`,
      accessToken: `access-${nextId()}`,
      apiToken: `sk-${nextId()}`,
      status: 'active',
      balance: 10_000,
    }).returning().get();
    const tokenFallback = await createToken(accountFallback.id, 'fallback-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 0,
      failCount: 0,
      totalCost: 0,
    }).run();

    const siteObserved = await createSite('observed-low-balance');
    const accountObserved = await db.insert(schema.accounts).values({
      siteId: siteObserved.id,
      username: `observed-low-balance-${nextId()}`,
      accessToken: `access-${nextId()}`,
      apiToken: `sk-${nextId()}`,
      status: 'active',
      balance: 0,
    }).returning().get();
    const tokenObserved = await createToken(accountObserved.id, 'observed-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountObserved.id,
      tokenId: tokenObserved.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 10,
      failCount: 0,
      totalCost: 10, // observed unit cost = 1
    }).run();

    const decision = await new TokenRouter().explainSelection('gpt-5-nano');
    const fallbackCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('fallback-high-balance'));
    const observedCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('observed-low-balance'));

    expect(fallbackCandidate).toBeTruthy();
    expect(observedCandidate).toBeTruthy();
    expect((fallbackCandidate?.probability || 0)).toBeLessThan(1);
    expect((observedCandidate?.probability || 0)).toBeGreaterThan(99);
    expect(fallbackCandidate?.reason || '').toContain('成本=默认:1000.000000');
  });

  it('uses cached catalog routing cost when observed and configured costs are missing', async () => {
    config.routingWeights = {
      baseWeightFactor: 0.35,
      valueScoreFactor: 0.65,
      costWeight: 1,
      balanceWeight: 0,
      usageWeight: 0,
    };
    config.routingFallbackUnitCost = 100;

    const route = await createRoute('claude-sonnet-4-5-20250929');

    const siteCatalog = await createSite('catalog-site');
    const accountCatalog = await createAccount(siteCatalog.id, 'catalog-user');
    const tokenCatalog = await createToken(accountCatalog.id, 'catalog-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountCatalog.id,
      tokenId: tokenCatalog.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 0,
      failCount: 0,
      totalCost: 0,
    }).run();

    const siteFallback = await createSite('fallback-site');
    const accountFallback = await createAccount(siteFallback.id, 'fallback-user');
    const tokenFallback = await createToken(accountFallback.id, 'fallback-token');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 0,
      failCount: 0,
      totalCost: 0,
    }).run();

    mockedCatalogRoutingCost.mockImplementation(({ accountId, modelName }) => {
      if (accountId !== accountCatalog.id) return null;
      if (modelName !== 'claude-sonnet-4-5-20250929') return null;
      return 0.2;
    });

    const decision = await new TokenRouter().explainSelection('claude-sonnet-4-5-20250929');
    const catalogCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('catalog-site'));
    const fallbackCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('fallback-site'));

    expect(catalogCandidate).toBeTruthy();
    expect(fallbackCandidate).toBeTruthy();
    expect((catalogCandidate?.probability || 0)).toBeGreaterThan(fallbackCandidate?.probability || 0);
    expect(catalogCandidate?.reason || '').toContain('成本=目录:0.200000');
    expect(fallbackCandidate?.reason || '').toContain('成本=默认:100.000000');
  });

  it('downweights a site after transient failures and restores it quickly after success', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-5.4');

    const siteA = await createSite('runtime-a');
    const accountA = await createAccount(siteA.id, 'runtime-user-a');
    const tokenA = await createToken(accountA.id, 'runtime-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('runtime-b');
    const accountB = await createAccount(siteB.id, 'runtime-user-b');
    const tokenB = await createToken(accountB.id, 'runtime-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    let decision = await router.explainSelection('gpt-5.4');
    let candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    let candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect(candidateA?.probability).toBeCloseTo(50, 1);
    expect(candidateB?.probability).toBeCloseTo(50, 1);

    await router.recordFailure(channelA.id, {
      status: 502,
      errorText: 'Bad gateway',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelA.id)).run();
    invalidateTokenRouterCache();

    decision = await router.explainSelection('gpt-5.4');
    candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect(candidateA).toBeTruthy();
    expect(candidateB).toBeTruthy();
    expect((candidateA?.probability || 0)).toBeLessThan(30);
    expect(candidateA?.reason || '').toContain('运行时健康=');
    expect((candidateB?.probability || 0)).toBeGreaterThan(70);

    await router.recordSuccess(channelA.id, 800, 0);
    invalidateTokenRouterCache();

    decision = await router.explainSelection('gpt-5.4');
    candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect((candidateA?.probability || 0)).toBeGreaterThan(40);
    expect((candidateB?.probability || 0)).toBeLessThan(60);
  });

  it('opens a site breaker after repeated transient failures and closes it after recovery', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-5.3');

    const siteA = await createSite('breaker-a');
    const accountA = await createAccount(siteA.id, 'breaker-user-a');
    const tokenA = await createToken(accountA.id, 'breaker-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('breaker-b');
    const accountB = await createAccount(siteB.id, 'breaker-user-b');
    const tokenB = await createToken(accountB.id, 'breaker-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    for (let index = 0; index < 3; index += 1) {
      await router.recordFailure(channelA.id, {
        status: 502,
        errorText: 'Gateway timeout',
      });
    }
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelA.id)).run();
    invalidateTokenRouterCache();

    let decision = await router.explainSelection('gpt-5.3');
    const breakerCandidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const breakerCandidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect(breakerCandidateA?.reason || '').toContain('站点熔断');
    expect((breakerCandidateA?.probability || 0)).toBe(0);
    expect((breakerCandidateB?.probability || 0)).toBe(100);
    expect(decision.summary.join(' ')).toContain('站点熔断避让');

    await router.recordSuccess(channelA.id, 600, 0);
    invalidateTokenRouterCache();

    decision = await router.explainSelection('gpt-5.3');
    const recoveredCandidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const recoveredCandidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect(recoveredCandidateA?.reason || '').not.toContain('站点熔断');
    expect(recoveredCandidateA?.circuitStatus?.isOpen).toBe(false);
    expect((recoveredCandidateA?.probability || 0) + (recoveredCandidateB?.probability || 0)).toBeGreaterThan(0);
    expect(decision.summary.join(' ')).toContain('最终选择');
  });

  it('uses persisted site success and latency history to prefer historically healthier sites', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('claude-4-sonnet');

    const siteStable = await createSite('history-stable');
    const accountStable = await createAccount(siteStable.id, 'history-user-stable');
    const tokenStable = await createToken(accountStable.id, 'history-token-stable');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountStable.id,
      tokenId: tokenStable.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 90,
      failCount: 10,
      totalLatencyMs: 90 * 240,
    }).run();

    const siteWeak = await createSite('history-weak');
    const accountWeak = await createAccount(siteWeak.id, 'history-user-weak');
    const tokenWeak = await createToken(accountWeak.id, 'history-token-weak');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountWeak.id,
      tokenId: tokenWeak.id,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 20,
      failCount: 30,
      totalLatencyMs: 20 * 5200,
    }).run();

    const decision = await new TokenRouter().explainSelection('claude-4-sonnet');
    const stableCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('history-stable'));
    const weakCandidate = decision.candidates.find((candidate) => candidate.siteName.startsWith('history-weak'));

    expect(stableCandidate).toBeTruthy();
    expect(weakCandidate).toBeTruthy();
    expect((stableCandidate?.probability || 0)).toBeGreaterThan(weakCandidate?.probability || 0);
    expect(stableCandidate?.reason || '').toContain('历史健康=');
    expect(stableCandidate?.reason || '').toContain('成功率=90.0%');
    expect(weakCandidate?.reason || '').toContain('成功率=40.0%');
  });

  it('reloads persisted runtime health after in-memory reset', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-4o-mini');

    const siteA = await createSite('persist-a');
    const accountA = await createAccount(siteA.id, 'persist-user-a');
    const tokenA = await createToken(accountA.id, 'persist-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('persist-b');
    const accountB = await createAccount(siteB.id, 'persist-user-b');
    const tokenB = await createToken(accountB.id, 'persist-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channelA.id, {
      status: 502,
      errorText: 'Gateway timeout',
      modelName: 'gpt-4o-mini',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelA.id)).run();
    await flushSiteRuntimeHealthPersistence();

    const persisted = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'token_router_site_runtime_health_v1'))
      .get();
    expect(persisted?.value).toBeTruthy();

    resetSiteRuntimeHealthState();
    invalidateTokenRouterCache();

    const decision = await new TokenRouter().explainSelection('gpt-4o-mini');
    const candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);

    expect(candidateA).toBeTruthy();
    expect(candidateB).toBeTruthy();
    expect((candidateA?.probability || 0)).toBeLessThan((candidateB?.probability || 0));
    expect(candidateA?.reason || '').toContain('运行时健康=');
  });

  it('penalizes the failed model more than unrelated models on the same site', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const gptRoute = await createRoute('gpt-5.4');
    const claudeRoute = await createRoute('claude-sonnet-4-6');

    const siteA = await createSite('model-aware-a');
    const accountA = await createAccount(siteA.id, 'model-aware-user-a');
    const tokenA = await createToken(accountA.id, 'model-aware-token-a');
    const gptChannelA = await db.insert(schema.routeChannels).values({
      routeId: gptRoute.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: claudeRoute.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const siteB = await createSite('model-aware-b');
    const accountB = await createAccount(siteB.id, 'model-aware-user-b');
    const tokenB = await createToken(accountB.id, 'model-aware-token-b');
    await db.insert(schema.routeChannels).values([
      {
        routeId: gptRoute.id,
        accountId: accountB.id,
        tokenId: tokenB.id,
        priority: 0,
        weight: 10,
        enabled: true,
      },
      {
        routeId: claudeRoute.id,
        accountId: accountB.id,
        tokenId: tokenB.id,
        priority: 0,
        weight: 10,
        enabled: true,
      },
    ]).run();

    const router = new TokenRouter();
    await router.recordFailure(gptChannelA.id, {
      status: 502,
      errorText: 'Bad gateway',
      modelName: 'gpt-5.4',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, gptChannelA.id)).run();
    invalidateTokenRouterCache();

    const gptDecision = await router.explainSelection('gpt-5.4');
    const claudeDecision = await router.explainSelection('claude-sonnet-4-6');
    const gptCandidateA = gptDecision.candidates.find((candidate) => candidate.siteName.startsWith('model-aware-a'));
    const claudeCandidateA = claudeDecision.candidates.find((candidate) => candidate.siteName.startsWith('model-aware-a'));

    expect(gptCandidateA).toBeTruthy();
    expect(claudeCandidateA).toBeTruthy();
    expect((gptCandidateA?.probability || 0)).toBeLessThan((claudeCandidateA?.probability || 0));
    expect(gptCandidateA?.reason || '').toContain('模型=');
  });

  it('stable_first deterministically chooses the healthiest candidate', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.1',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const siteA = await createSite('stable-first-a');
    const accountA = await createAccount(siteA.id, 'stable-first-user-a');
    const tokenA = await createToken(accountA.id, 'stable-first-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('stable-first-b');
    const accountB = await createAccount(siteB.id, 'stable-first-user-b');
    const tokenB = await createToken(accountB.id, 'stable-first-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channelA.id, {
      status: 502,
      errorText: 'Gateway timeout',
      modelName: 'gpt-5.1',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelA.id)).run();
    invalidateTokenRouterCache();

    const preview = await router.previewSelectedChannel('gpt-5.1');
    const decision = await router.explainSelection('gpt-5.1');

    expect(preview?.channel.id).toBe(channelB.id);
    expect(decision.summary.join(' ')).toContain('稳定优先');
    expect(decision.selectedChannelId).toBe(channelB.id);
  });

  it('reuses the most recently successful site before retrying other sites', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gemini-2.5-pro');

    const siteRecent = await createSite('recent-success');
    const accountRecent = await createAccount(siteRecent.id, 'recent-success-user');
    const tokenRecent = await createToken(accountRecent.id, 'recent-success-token');
    const channelRecent = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountRecent.id,
      tokenId: tokenRecent.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteOther = await createSite('other-site');
    const accountOther = await createAccount(siteOther.id, 'other-site-user');
    const tokenOther = await createToken(accountOther.id, 'other-site-token');
    const channelOther = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountOther.id,
      tokenId: tokenOther.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordSuccess(channelRecent.id, 450, 0, 'gemini-2.5-pro');
    invalidateTokenRouterCache();

    const preview = await router.previewSelectedChannel('gemini-2.5-pro');
    const decision = await router.explainSelection('gemini-2.5-pro');
    const recentCandidate = decision.candidates.find((candidate) => candidate.channelId === channelRecent.id);
    const otherCandidate = decision.candidates.find((candidate) => candidate.channelId === channelOther.id);

    expect(preview?.channel.id).toBe(channelRecent.id);
    expect(decision.selectedChannelId).toBe(channelRecent.id);
    expect(recentCandidate?.probability || 0).toBeGreaterThan(99);
    expect(otherCandidate?.probability || 0).toBe(0);
    expect(otherCandidate?.reason || '').toContain('最近成功站点');
    expect(decision.summary.join(' ')).toContain('最近成功站点复用');
  });

  it('falls through to the next priority when all higher-priority channels recently failed', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-5.6');

    const sitePrimary = await createSite('degrade-primary');
    const accountPrimary = await createAccount(sitePrimary.id, 'degrade-user-primary');
    const tokenPrimary = await createToken(accountPrimary.id, 'degrade-token-primary');
    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountPrimary.id,
      tokenId: tokenPrimary.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteFallback = await createSite('degrade-fallback');
    const accountFallback = await createAccount(siteFallback.id, 'degrade-user-fallback');
    const tokenFallback = await createToken(accountFallback.id, 'degrade-token-fallback');
    const fallbackChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 10,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(primaryChannel.id, {
      status: 503,
      errorText: 'service unavailable',
      modelName: 'gpt-5.6',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
    }).where(eq(schema.routeChannels.id, primaryChannel.id)).run();
    invalidateTokenRouterCache();

    const preview = await router.previewSelectedChannel('gpt-5.6');
    const decision = await router.explainSelection('gpt-5.6');
    const primaryCandidate = decision.candidates.find((candidate) => candidate.channelId === primaryChannel.id);
    const fallbackCandidate = decision.candidates.find((candidate) => candidate.channelId === fallbackChannel.id);

    expect(preview?.channel.id).toBe(fallbackChannel.id);
    expect(decision.selectedChannelId).toBe(fallbackChannel.id);
    expect(primaryCandidate?.avoidedByRecentFailure).toBe(true);
    expect(primaryCandidate?.reason || '').toContain('最近失败');
    expect(fallbackCandidate?.probability || 0).toBeGreaterThan(0);
    expect(decision.summary.join(' ')).toContain('上层最近失败，已自动降级');
  });

  it('does not select a channel when every priority layer recently failed', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-5.7');

    const sitePrimary = await createSite('retry-primary');
    const accountPrimary = await createAccount(sitePrimary.id, 'retry-user-primary');
    const tokenPrimary = await createToken(accountPrimary.id, 'retry-token-primary');
    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountPrimary.id,
      tokenId: tokenPrimary.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteFallback = await createSite('retry-fallback');
    const accountFallback = await createAccount(siteFallback.id, 'retry-user-fallback');
    const tokenFallback = await createToken(accountFallback.id, 'retry-token-fallback');
    const fallbackChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 10,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(primaryChannel.id, {
      status: 503,
      errorText: 'service unavailable',
      modelName: 'gpt-5.7',
    });
    await router.recordFailure(fallbackChannel.id, {
      status: 503,
      errorText: 'service unavailable',
      modelName: 'gpt-5.7',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
    }).where(eq(schema.routeChannels.routeId, route.id)).run();
    invalidateTokenRouterCache();

    const preview = await router.previewSelectedChannel('gpt-5.7');
    const decision = await router.explainSelection('gpt-5.7');

    expect(preview).toBeNull();
    expect(decision.selectedChannelId).toBeUndefined();
    expect(decision.summary.join(' ')).toContain('当前避让中');
    expect(decision.summary.join(' ')).toContain('本次未选出通道');
  });

  it('temporarily avoids channels that were just selected by another request', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-selection-lease');

    const sitePrimary = await createSite('lease-primary');
    const accountPrimary = await createAccount(sitePrimary.id, 'lease-user-primary');
    const tokenPrimary = await createToken(accountPrimary.id, 'lease-token-primary');
    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountPrimary.id,
      tokenId: tokenPrimary.id,
      priority: 0,
      weight: 20,
      enabled: true,
    }).returning().get();

    const siteFallback = await createSite('lease-fallback');
    const accountFallback = await createAccount(siteFallback.id, 'lease-user-fallback');
    const tokenFallback = await createToken(accountFallback.id, 'lease-token-fallback');
    const fallbackChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 0,
      weight: 5,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const first = await router.selectChannel('gpt-selection-lease');
      const second = await router.previewSelectedChannel('gpt-selection-lease');
      const decision = await router.explainSelection('gpt-selection-lease');
      const primaryCandidate = decision.candidates.find((candidate) => candidate.channelId === primaryChannel.id);
      const fallbackCandidate = decision.candidates.find((candidate) => candidate.channelId === fallbackChannel.id);

      expect(first?.channel.id).toBe(primaryChannel.id);
      expect(second?.channel.id).toBe(fallbackChannel.id);
      expect((primaryCandidate?.avoidedByInflightLease || primaryCandidate?.avoidedByAccountLease) ?? false).toBe(true);
      expect(primaryCandidate?.reason || '').toMatch(/通道忙碌中|账号并发繁忙/);
      expect((primaryCandidate?.leasedUntil || primaryCandidate?.accountLeaseUntil) ?? null).toBeTruthy();
      expect(fallbackCandidate?.probability || 0).toBeGreaterThan(0);
      expect(decision.summary.join(' ')).toMatch(/并发占用避让|账号并发避让/);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('restores persisted unavailable model state after a later successful request', async () => {
    const route = await createRoute('gpt-4o-persisted-recover');
    const site = await createSite('persist-recover');
    const account = await createAccount(site.id, 'persist-recover-user');
    const token = await createToken(account.id, 'persist-recover-token');
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channel.id, {
      status: 400,
      errorText: 'model not supported',
      modelName: 'gpt-4o-persisted-recover',
    });

    let availability = await db.select().from(schema.tokenModelAvailability)
      .where(
        and(
          eq(schema.tokenModelAvailability.tokenId, token.id),
          eq(schema.tokenModelAvailability.modelName, 'gpt-4o-persisted-recover'),
        ),
      )
      .get();
    expect(availability?.available).toBe(false);

    await router.recordSuccess(channel.id, 320, 0.1, 'gpt-4o-persisted-recover');

    availability = await db.select().from(schema.tokenModelAvailability)
      .where(
        and(
          eq(schema.tokenModelAvailability.tokenId, token.id),
          eq(schema.tokenModelAvailability.modelName, 'gpt-4o-persisted-recover'),
        ),
      )
      .get();
    expect(availability?.available).toBe(true);
  });

  it('prefers accounts with higher success EMA and exposes account runtime snapshots', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-account-ema');

    const siteA = await createSite('account-ema-a');
    const accountA = await createAccount(siteA.id, 'account-ema-user-a');
    const tokenA = await createToken(accountA.id, 'account-ema-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('account-ema-b');
    const accountB = await createAccount(siteB.id, 'account-ema-user-b');
    const tokenB = await createToken(accountB.id, 'account-ema-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordSuccess(channelA.id, 400, 0, 'gpt-account-ema');
    await router.recordSuccess(channelA.id, 380, 0, 'gpt-account-ema');
    await router.recordFailure(channelB.id, {
      status: 503,
      errorText: 'service unavailable',
      modelName: 'gpt-account-ema',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelB.id)).run();
    invalidateTokenRouterCache();

    const decision = await router.explainSelection('gpt-account-ema');
    const candidateA = decision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const candidateB = decision.candidates.find((candidate) => candidate.channelId === channelB.id);
    expect((candidateA?.probability || 0)).toBeGreaterThan(candidateB?.probability || 0);
    expect((candidateA?.reason || '').includes('账号EMA=') || decision.summary.join(' ').includes('最近成功站点复用')).toBe(true);

    const accountSnapshots = await listAccountRoutingRuntimeSnapshots();
    const snapshotA = accountSnapshots.find((item) => item.accountId === accountA.id);
    const snapshotB = accountSnapshots.find((item) => item.accountId === accountB.id);
    expect(snapshotA?.successEma || 0).toBeGreaterThan(snapshotB?.successEma || 0);
    expect(snapshotA?.latencyEmaMs || 0).toBeGreaterThan(0);
  });

  it('falls back to another account when the preferred account exhausts its rate budget without consuming budget during preview', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-account-rate-budget',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const sitePrimary = await createSite('budget-primary');
    const accountPrimary = await createAccount(sitePrimary.id, 'budget-user-primary');
    const tokenPrimary = await createToken(accountPrimary.id, 'budget-token-primary');
    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountPrimary.id,
      tokenId: tokenPrimary.id,
      priority: 0,
      weight: 20,
      enabled: true,
    }).returning().get();

    const siteFallback = await createSite('budget-fallback');
    const accountFallback = await createAccount(siteFallback.id, 'budget-user-fallback');
    const tokenFallback = await createToken(accountFallback.id, 'budget-token-fallback');
    const fallbackChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 0,
      weight: 5,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const nowMs = Date.now();
      await db.insert(schema.settings).values({
        key: 'token_router_account_budget_v1',
        value: JSON.stringify({
          version: 1,
          savedAtMs: nowMs,
          byAccountId: {
            [String(accountPrimary.id)]: {
              budget: {
                tokens: 0.2,
                capacity: 2,
                refillPerSec: 1.2,
                lastRefillAtMs: nowMs,
                lastGrantedAtMs: null,
                denyUntilMs: null,
                updatedAtMs: nowMs,
              },
              inflightLeases: [],
            },
          },
        }),
      }).run();
      resetSiteRuntimeHealthState();
      invalidateTokenRouterCache();

      const primaryBeforePreview = (await listAccountRoutingRuntimeSnapshots())
        .find((item) => item.accountId === accountPrimary.id);
      expect(primaryBeforePreview?.rateLimitTokens || 0).toBeLessThan(1);

      const preview = await router.previewSelectedChannel('gpt-account-rate-budget');
      const primaryAfterPreview = (await listAccountRoutingRuntimeSnapshots())
        .find((item) => item.accountId === accountPrimary.id);
      const decision = await router.explainSelection('gpt-account-rate-budget');
      const primaryCandidate = decision.candidates.find((candidate) => candidate.channelId === primaryChannel.id);
      expect(preview?.channel.id).toBe(fallbackChannel.id);
      expect(primaryAfterPreview?.rateLimitTokens || 0).toBeCloseTo(primaryBeforePreview?.rateLimitTokens || 0, 3);
      expect(primaryCandidate?.avoidedByAccountLease || primaryCandidate?.reason.includes('账号速率')).toBe(true);
      expect(primaryCandidate?.reason || '').toMatch(/账号速率预算不足|账号速率受限/);
      expect(primaryCandidate?.accountRuntimeState?.rateLimitTokens || 0).toBeLessThan(1);
      expect(decision.summary.join(' ')).toContain('账号预算避让');
    } finally {
      vi.useRealTimers();
      randomSpy.mockRestore();
    }

    expect(fallbackChannel.id).not.toBe(primaryChannel.id);
  });

  it('recovers the preferred account after the rate budget refill window elapses', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-account-rate-budget-recover',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const sitePrimary = await createSite('budget-recover-primary');
    const accountPrimary = await createAccount(sitePrimary.id, 'budget-recover-user-primary');
    const tokenPrimary = await createToken(accountPrimary.id, 'budget-recover-token-primary');
    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountPrimary.id,
      tokenId: tokenPrimary.id,
      priority: 0,
      weight: 20,
      enabled: true,
    }).returning().get();

    const siteFallback = await createSite('budget-recover-fallback');
    const accountFallback = await createAccount(siteFallback.id, 'budget-recover-user-fallback');
    const tokenFallback = await createToken(accountFallback.id, 'budget-recover-token-fallback');
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 0,
      weight: 5,
      enabled: true,
    }).run();

    const router = new TokenRouter();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const nowMs = Date.now();
      await db.insert(schema.settings).values({
        key: 'token_router_account_budget_v1',
        value: JSON.stringify({
          version: 1,
          savedAtMs: nowMs,
          byAccountId: {
            [String(accountPrimary.id)]: {
              budget: {
                tokens: 0.2,
                capacity: 2,
                refillPerSec: 1.2,
                lastRefillAtMs: nowMs,
                lastGrantedAtMs: null,
                denyUntilMs: null,
                updatedAtMs: nowMs,
              },
              inflightLeases: [],
            },
          },
        }),
      }).run();
      resetSiteRuntimeHealthState();
      invalidateTokenRouterCache();

      const limitedPreview = await router.previewSelectedChannel('gpt-account-rate-budget-recover');
      expect(limitedPreview?.channel.id).not.toBe(primaryChannel.id);

      await vi.advanceTimersByTimeAsync(4_000);

      const primaryBeforeRecovery = (await listAccountRoutingRuntimeSnapshots())
        .find((item) => item.accountId === accountPrimary.id);
      const recoveredPreview = await router.previewSelectedChannel('gpt-account-rate-budget-recover');
      const decision = await router.explainSelection('gpt-account-rate-budget-recover');
      const primaryCandidate = decision.candidates.find((candidate) => candidate.channelId === primaryChannel.id);
      expect(primaryBeforeRecovery?.rateLimitTokens || 0).toBeGreaterThanOrEqual(1);
      expect(recoveredPreview?.channel.id).toBe(primaryChannel.id);
      expect(primaryCandidate?.accountRuntimeState?.rateLimitTokens || 0).toBeGreaterThanOrEqual(1);
      expect(primaryCandidate?.reason || '').not.toMatch(/账号速率预算不足|账号速率受限/);
    } finally {
      vi.useRealTimers();
      randomSpy.mockRestore();
    }
  });

  it('applies sticky session preference and breaks stickiness when the bound account is busy', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-sticky-session',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const siteA = await createSite('sticky-a');
    const accountA = await createAccount(siteA.id, 'sticky-user-a');
    const tokenA = await createToken(accountA.id, 'sticky-token-a');
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteB = await createSite('sticky-b');
    const accountB = await createAccount(siteB.id, 'sticky-user-b');
    const tokenB = await createToken(accountB.id, 'sticky-token-b');
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const stickyPolicy = {
      supportedModels: [],
      allowedRouteIds: [],
      siteWeightMultipliers: {},
      stickySessionKey: 'managed:test:/v1/chat:session-1',
    };

    const first = await router.selectChannel('gpt-sticky-session', stickyPolicy);
    const second = await router.previewSelectedChannel('gpt-sticky-session', stickyPolicy);
    const decisionWhileBusy = await router.explainSelection('gpt-sticky-session', [], stickyPolicy);
    const candidateAWhileBusy = decisionWhileBusy.candidates.find((candidate) => candidate.channelId === channelA.id);
    const candidateBWhileBusy = decisionWhileBusy.candidates.find((candidate) => candidate.channelId === channelB.id);

    expect(first?.channel.id).toBe(channelA.id);
    expect(second?.channel.id).toBe(channelB.id);
    expect(candidateAWhileBusy?.accountRuntimeState?.stickyActive).toBe(true);
    expect(candidateAWhileBusy?.accountRuntimeState?.stickyPreferred).toBe(false);
    expect(candidateAWhileBusy?.avoidedByAccountLease).toBe(true);
    expect(decisionWhileBusy.summary.join(' ')).toContain('账号粘性已打破');
    expect(decisionWhileBusy.summary.join(' ')).toContain('账号并发避让');
    expect((candidateBWhileBusy?.probability || 0)).toBeGreaterThan(0);

    await router.recordSuccess(channelA.id, 320, 0, 'gpt-sticky-session');
    const decisionRecovered = await router.explainSelection('gpt-sticky-session', [], stickyPolicy);
    const candidateARecovered = decisionRecovered.candidates.find((candidate) => candidate.channelId === channelA.id);
    expect(candidateARecovered?.accountRuntimeState?.stickyPreferred).toBe(true);
    expect(decisionRecovered.summary.join(' ')).toContain('账号粘性复用');
    expect(decisionRecovered.selectedChannelId).toBe(channelA.id);

    expect(channelB.id).not.toBe(channelA.id);
  });

  it('still reuses the most recently successful site after runtime memory is cleared', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gemini-2.5-flash');

    const siteRecent = await createSite('persist-recent-success');
    const accountRecent = await createAccount(siteRecent.id, 'persist-recent-success-user');
    const tokenRecent = await createToken(accountRecent.id, 'persist-recent-success-token');
    const channelRecent = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountRecent.id,
      tokenId: tokenRecent.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteOther = await createSite('persist-other-site');
    const accountOther = await createAccount(siteOther.id, 'persist-other-site-user');
    const tokenOther = await createToken(accountOther.id, 'persist-other-site-token');
    const channelOther = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountOther.id,
      tokenId: tokenOther.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordSuccess(channelRecent.id, 500, 0, 'gemini-2.5-flash');
    await db.update(schema.routeChannels).set({
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      successCount: 1,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelRecent.id)).run();
    await db.update(schema.routeChannels).set({
      lastUsedAt: '2025-12-31T23:50:00.000Z',
      successCount: 1,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, channelOther.id)).run();
    await flushSiteRuntimeHealthPersistence();

    resetSiteRuntimeHealthState();
    invalidateTokenRouterCache();

    const preview = await new TokenRouter().previewSelectedChannel('gemini-2.5-flash');
    const decision = await new TokenRouter().explainSelection('gemini-2.5-flash');
    const recentCandidate = decision.candidates.find((candidate) => candidate.channelId === channelRecent.id);
    const otherCandidate = decision.candidates.find((candidate) => candidate.channelId === channelOther.id);

    expect(preview?.channel.id).toBe(channelRecent.id);
    expect(decision.selectedChannelId).toBe(channelRecent.id);
    expect(recentCandidate?.probability || 0).toBeGreaterThan(99);
    expect(otherCandidate?.probability || 0).toBe(0);
    expect(otherCandidate?.reason || '').toContain('最近成功站点');
  });

  it('does not fall back to a runtime-breaker-blocked layer when only lower priorities are recently failed', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-runtime-breaker-guard');

    const sitePrimary = await createSite('runtime-breaker-primary');
    const accountPrimary = await createAccount(sitePrimary.id, 'runtime-breaker-user-primary');
    const tokenPrimary = await createToken(accountPrimary.id, 'runtime-breaker-token-primary');
    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountPrimary.id,
      tokenId: tokenPrimary.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteFallback = await createSite('runtime-breaker-fallback');
    const accountFallback = await createAccount(siteFallback.id, 'runtime-breaker-user-fallback');
    const tokenFallback = await createToken(accountFallback.id, 'runtime-breaker-token-fallback');
    const fallbackChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountFallback.id,
      tokenId: tokenFallback.id,
      priority: 10,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(primaryChannel.id, {
      status: 503,
      errorText: 'service unavailable',
      modelName: 'gpt-runtime-breaker-guard',
    });
    await router.recordFailure(primaryChannel.id, {
      status: 503,
      errorText: 'service unavailable',
      modelName: 'gpt-runtime-breaker-guard',
    });
    await router.recordFailure(primaryChannel.id, {
      status: 503,
      errorText: 'service unavailable',
      modelName: 'gpt-runtime-breaker-guard',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).where(eq(schema.routeChannels.id, primaryChannel.id)).run();

    await router.recordFailure(fallbackChannel.id, {
      status: 503,
      errorText: 'service unavailable',
      modelName: 'gpt-runtime-breaker-guard',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
    }).where(eq(schema.routeChannels.id, fallbackChannel.id)).run();
    invalidateTokenRouterCache();

    const preview = await router.previewSelectedChannel('gpt-runtime-breaker-guard');
    const decision = await router.explainSelection('gpt-runtime-breaker-guard');
    const primaryCandidate = decision.candidates.find((candidate) => candidate.channelId === primaryChannel.id);
    const fallbackCandidate = decision.candidates.find((candidate) => candidate.channelId === fallbackChannel.id);

    expect(preview).toBeNull();
    expect(decision.selectedChannelId).toBeUndefined();
    expect(primaryCandidate?.eligible).toBe(false);
    expect(primaryCandidate?.reason || '').toContain('熔断');
    expect(fallbackCandidate?.avoidedByRecentFailure).toBe(true);
    expect(fallbackCandidate?.reason || '').toContain('最近失败');
    expect(decision.summary.join(' ')).toContain('本次未选出通道');
  });

  it('extends cooldown for auth-like failures to avoid hammering bad tokens', async () => {
    const route = await createRoute('gpt-auth-cooldown');

    const site = await createSite('auth-cooldown');
    const account = await createAccount(site.id, 'auth-cooldown-user');
    const token = await createToken(account.id, 'auth-cooldown-token');
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const beforeMs = Date.now();
    await router.recordFailure(channel.id, {
      status: 401,
      errorText: 'invalid api key',
      modelName: 'gpt-auth-cooldown',
    });

    const stored = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    const cooldownMs = stored?.cooldownUntil ? Date.parse(stored.cooldownUntil) - beforeMs : 0;

    expect(cooldownMs).toBeGreaterThanOrEqual(29 * 60 * 1000);
  });

  it('hard-skips the same channel for the failing model while preserving other models on that channel', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-4o-hard-skip');
    const otherRoute = await createRoute('claude-sonnet-hard-skip');

    const primarySite = await createSite('hard-skip-primary');
    const primaryAccount = await createAccount(primarySite.id, 'hard-skip-user-primary');
    const primaryToken = await createToken(primaryAccount.id, 'hard-skip-token-primary');
    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: primaryAccount.id,
      tokenId: primaryToken.id,
      priority: 0,
      weight: 20,
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: otherRoute.id,
      accountId: primaryAccount.id,
      tokenId: primaryToken.id,
      priority: 0,
      weight: 20,
      enabled: true,
    }).run();

    const backupSite = await createSite('hard-skip-backup');
    const backupAccount = await createAccount(backupSite.id, 'hard-skip-user-backup');
    const backupToken = await createToken(backupAccount.id, 'hard-skip-token-backup');
    const backupChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: backupAccount.id,
      tokenId: backupToken.id,
      priority: 0,
      weight: 5,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(primaryChannel.id, {
      status: 403,
      errorText: 'model not supported',
      modelName: 'gpt-4o-hard-skip',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).where(eq(schema.routeChannels.id, primaryChannel.id)).run();
    invalidateTokenRouterCache();

    const decision = await router.explainSelection('gpt-4o-hard-skip');
    const primaryCandidate = decision.candidates.find((candidate) => candidate.channelId === primaryChannel.id);
    const backupCandidate = decision.candidates.find((candidate) => candidate.channelId === backupChannel.id);
    const preview = await router.previewSelectedChannel('gpt-4o-hard-skip');
    const otherModelPreview = await router.previewSelectedChannel('claude-sonnet-hard-skip');

    expect(decision.summary.join(' ')).toContain('模型熔断避让');
    expect(primaryCandidate?.eligible).toBe(false);
    expect(primaryCandidate?.reason || '').toContain('模型熔断中');
    expect(primaryCandidate?.modelCircuitStatus?.isOpen).toBe(true);
    expect(backupCandidate?.eligible).toBe(true);
    expect(preview?.channel.id).toBe(backupChannel.id);
    expect(otherModelPreview?.account.id).toBe(primaryAccount.id);
  });

  it('keeps a protocol-mismatched channel selectable after cooldown is manually cleared', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-5.2-codex-hard-protocol-skip');
    const otherRoute = await createRoute('gpt-4o-mini-hard-protocol-skip');

    const primarySite = await createSite('hard-protocol-primary');
    const primaryAccount = await createAccount(primarySite.id, 'hard-protocol-user-primary');
    const primaryToken = await createToken(primaryAccount.id, 'hard-protocol-token-primary');
    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: primaryAccount.id,
      tokenId: primaryToken.id,
      priority: 0,
      weight: 20,
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: otherRoute.id,
      accountId: primaryAccount.id,
      tokenId: primaryToken.id,
      priority: 0,
      weight: 20,
      enabled: true,
    }).run();

    const backupSite = await createSite('hard-protocol-backup');
    const backupAccount = await createAccount(backupSite.id, 'hard-protocol-user-backup');
    const backupToken = await createToken(backupAccount.id, 'hard-protocol-token-backup');
    const backupChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: backupAccount.id,
      tokenId: backupToken.id,
      priority: 0,
      weight: 5,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(primaryChannel.id, {
      status: 403,
      errorText: 'This group does not allow /v1/messages dispatch',
      modelName: 'gpt-5.2-codex-hard-protocol-skip',
    });
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).where(eq(schema.routeChannels.id, primaryChannel.id)).run();
    invalidateTokenRouterCache();

    const decision = await router.explainSelection('gpt-5.2-codex-hard-protocol-skip');
    const primaryCandidate = decision.candidates.find((candidate) => candidate.channelId === primaryChannel.id);
    const backupCandidate = decision.candidates.find((candidate) => candidate.channelId === backupChannel.id);
    const preview = await router.previewSelectedChannel('gpt-5.2-codex-hard-protocol-skip');
    const otherModelPreview = await router.previewSelectedChannel('gpt-4o-mini-hard-protocol-skip');

    expect(decision.summary.join(' ')).not.toContain('模型熔断避让');
    expect(primaryCandidate?.modelCircuitStatus?.isOpen).toBe(false);
    expect(primaryCandidate?.reason || '').toContain('模型熔断=关闭');
    expect(backupCandidate?.eligible).toBe(true);
    expect(preview?.channel.id).toBeTruthy();
    expect(otherModelPreview?.channel.id).toBeTruthy();
    expect(otherModelPreview?.channel.id).not.toBe(backupChannel.id);
  });

  it('treats request-scoped site exclusion as temporary and does not turn it into a persistent site ban', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-request-site-exclude');
    const otherRoute = await createRoute('claude-request-site-exclude');

    const primarySite = await createSite('request-site-primary');
    const primaryAccount = await createAccount(primarySite.id, 'request-site-primary-user');
    const primaryToken = await createToken(primaryAccount.id, 'request-site-primary-token');
    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: primaryAccount.id,
      tokenId: primaryToken.id,
      priority: 0,
      weight: 20,
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: otherRoute.id,
      accountId: primaryAccount.id,
      tokenId: primaryToken.id,
      priority: 0,
      weight: 20,
      enabled: true,
    }).run();

    const backupSite = await createSite('request-site-backup');
    const backupAccount = await createAccount(backupSite.id, 'request-site-backup-user');
    const backupToken = await createToken(backupAccount.id, 'request-site-backup-token');
    const backupChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: backupAccount.id,
      tokenId: backupToken.id,
      priority: 0,
      weight: 5,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const preview = await router.previewSelectedChannel('gpt-request-site-exclude');
    const excludedDecision = await router.explainSelection(
      'gpt-request-site-exclude',
      [primaryChannel.id],
      undefined,
      new Set([primarySite.id]),
    );
    const normalDecision = await router.explainSelection('gpt-request-site-exclude');
    const otherModelPreview = await router.previewSelectedChannel('claude-request-site-exclude');
    const primaryCandidate = excludedDecision.candidates.find((candidate) => candidate.channelId === primaryChannel.id);
    const backupCandidate = excludedDecision.candidates.find((candidate) => candidate.channelId === backupChannel.id);

    expect(preview?.channel.id).toBe(primaryChannel.id);
    expect(excludedDecision.selectedChannelId).toBe(backupChannel.id);
    expect(primaryCandidate?.avoidedByAttemptedSite).toBe(true);
    expect(primaryCandidate?.reason || '').toContain('当前请求站点已失败');
    expect(backupCandidate?.probability || 0).toBeGreaterThan(99);
    expect(normalDecision.selectedChannelId).toBe(primaryChannel.id);
    expect(otherModelPreview?.account.id).toBe(primaryAccount.id);
  });

  it('persists model-unsupported failures into token model availability for token-backed channels', async () => {
    config.routingWeights = {
      baseWeightFactor: 1,
      valueScoreFactor: 0,
      costWeight: 0,
      balanceWeight: 0,
      usageWeight: 0,
    };

    const route = await createRoute('gpt-4o-persisted-unsupported');
    const site = await createSite('persist-unsupported');
    const account = await createAccount(site.id, 'persist-unsupported-user');
    const token = await createToken(account.id, 'persist-unsupported-token');
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-4o-persisted-unsupported',
      available: true,
    }).run();

    const router = new TokenRouter();
    await router.recordFailure(channel.id, {
      status: 400,
      errorText: 'model not supported',
      modelName: 'gpt-4o-persisted-unsupported',
    });

    const availability = await db.select().from(schema.tokenModelAvailability)
      .where(
        and(
          eq(schema.tokenModelAvailability.tokenId, token.id),
          eq(schema.tokenModelAvailability.modelName, 'gpt-4o-persisted-unsupported'),
        ),
      )
      .get();

    expect(availability?.available).toBe(false);
    expect(typeof availability?.checkedAt).toBe('string');
  });

  it('creates an unavailable token-model record when a model-unsupported failure was not previously tracked', async () => {
    const route = await createRoute('gpt-4o-create-unsupported');
    const site = await createSite('create-unsupported');
    const account = await createAccount(site.id, 'create-unsupported-user');
    const token = await createToken(account.id, 'create-unsupported-token');
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channel.id, {
      status: 400,
      errorText: 'model not supported',
      modelName: 'gpt-4o-create-unsupported',
    });

    const availability = await db.select().from(schema.tokenModelAvailability)
      .where(
        and(
          eq(schema.tokenModelAvailability.tokenId, token.id),
          eq(schema.tokenModelAvailability.modelName, 'gpt-4o-create-unsupported'),
        ),
      )
      .get();

    expect(availability?.available).toBe(false);
    expect(typeof availability?.checkedAt).toBe('string');
  });

  it('treats explicit 403 model denial as model unsupported and persists token-model isolation', async () => {
    const route = await createRoute('gpt-5.2-model-denied');
    const site = await createSite('model-denied');
    const account = await createAccount(site.id, 'model-denied-user');
    const token = await createToken(account.id, 'model-denied-token');
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channel.id, {
      status: 403,
      errorText: 'you do not have access to the model gpt-5.2',
      modelName: 'gpt-5.2-model-denied',
    });

    const availability = await db.select().from(schema.tokenModelAvailability)
      .where(
        and(
          eq(schema.tokenModelAvailability.tokenId, token.id),
          eq(schema.tokenModelAvailability.modelName, 'gpt-5.2-model-denied'),
        ),
      )
      .get();

    expect(availability?.available).toBe(false);
    expect(typeof availability?.checkedAt).toBe('string');
  });

  it('skips token channels that are persistently marked unavailable for the requested model', async () => {
    const route = await createRoute('gpt-4o-persisted-skip');

    const siteBlocked = await createSite('persisted-blocked');
    const accountBlocked = await createAccount(siteBlocked.id, 'persisted-blocked-user');
    const tokenBlocked = await createToken(accountBlocked.id, 'persisted-blocked-token');
    const blockedChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountBlocked.id,
      tokenId: tokenBlocked.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const siteHealthy = await createSite('persisted-healthy');
    const accountHealthy = await createAccount(siteHealthy.id, 'persisted-healthy-user');
    const tokenHealthy = await createToken(accountHealthy.id, 'persisted-healthy-token');
    const healthyChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountHealthy.id,
      tokenId: tokenHealthy.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: tokenBlocked.id,
      modelName: 'gpt-4o-persisted-skip',
      available: false,
    }).run();

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-4o-persisted-skip');
    const decision = await router.explainSelection('gpt-4o-persisted-skip');

    expect(selected?.channel.id).toBe(healthyChannel.id);
    const blockedCandidate = decision.candidates.find((candidate) => candidate.channelId === blockedChannel.id);
    const healthyCandidate = decision.candidates.find((candidate) => candidate.channelId === healthyChannel.id);
    expect(blockedCandidate?.eligible).toBe(false);
    expect(blockedCandidate?.reason || '').toContain('模型能力已标记不可用');
    expect(healthyCandidate?.eligible).toBe(true);
  });

  it('disables a definitively broken explicit token after auth failures so it is no longer routable', async () => {
    const route = await createRoute('gpt-4o-broken-token');

    const siteBroken = await createSite('broken-token');
    const accountBroken = await createAccount(siteBroken.id, 'broken-token-user');
    const tokenBroken = await createToken(accountBroken.id, 'broken-token-value');
    const brokenChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountBroken.id,
      tokenId: tokenBroken.id,
      priority: 0,
      weight: 15,
      enabled: true,
    }).returning().get();

    const siteHealthy = await createSite('healthy-token');
    const accountHealthy = await createAccount(siteHealthy.id, 'healthy-token-user');
    const tokenHealthy = await createToken(accountHealthy.id, 'healthy-token-value');
    const healthyChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountHealthy.id,
      tokenId: tokenHealthy.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(brokenChannel.id, {
      status: 401,
      errorText: 'invalid api key',
      modelName: 'gpt-4o-broken-token',
    });

    const storedToken = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, tokenBroken.id))
      .get();
    expect(storedToken?.enabled).toBe(false);

    const selected = await router.selectChannel('gpt-4o-broken-token');
    const decision = await router.explainSelection('gpt-4o-broken-token');
    const brokenCandidate = decision.candidates.find((candidate) => candidate.channelId === brokenChannel.id);
    const healthyCandidate = decision.candidates.find((candidate) => candidate.channelId === healthyChannel.id);

    expect(selected?.channel.id).toBe(healthyChannel.id);
    expect(brokenCandidate?.eligible).toBe(false);
    expect(brokenCandidate?.reason || '').toContain('令牌不可用');
    expect(healthyCandidate?.eligible).toBe(true);
  });
});
