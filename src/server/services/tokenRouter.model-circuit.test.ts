import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter model circuit breaker', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let resetAllModelCircuits: typeof import('./modelCircuitBreaker.js')['resetAllModelCircuits'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-circuit-'));
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

  it('avoids a channel for the specific failing model while keeping other models available', async () => {
    const siteA = await db.insert(schema.sites).values({
      name: 'circuit-a',
      url: 'https://circuit-a.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const siteB = await db.insert(schema.sites).values({
      name: 'circuit-b',
      url: 'https://circuit-b.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: siteA.id,
      username: 'user-a',
      accessToken: 'access-a',
      apiToken: 'sk-a',
      status: 'active',
      unitCost: 1,
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: siteB.id,
      username: 'user-b',
      accessToken: 'access-b',
      apiToken: 'sk-b',
      status: 'active',
      unitCost: 1,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const wildcardRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: wildcardRoute.id,
      accountId: accountA.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const router = new TokenRouter();
    await router.recordFailure(channelA.id, { status: 401, errorText: 'unauthorized', modelName: 'claude-opus-4-6' });

    const opusDecision = await router.explainSelection('claude-opus-4-6');
    const channelACandidate = opusDecision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const channelBCandidate = opusDecision.candidates.find((candidate) => candidate.channelId === channelB.id);

    expect(channelACandidate?.eligible).toBe(false);
    expect(channelACandidate?.reason || '').toContain('模型熔断');
    expect(channelACandidate?.modelCircuitStatus?.state).toBe('open');
    expect(channelACandidate?.modelCircuitStatus?.isOpen).toBe(true);
    expect(channelACandidate?.modelCircuitStatus?.reason || '').toContain('模型熔断');
    expect(channelBCandidate?.eligible).toBe(true);
    expect(channelBCandidate?.modelCircuitStatus?.state).toBe('closed');

    const otherModelSelection = await router.selectChannel('gpt-4o-mini');
    expect(otherModelSelection?.account.id).toBe(accountA.id);
  });

  it('keeps sibling channels available on the same site when auth failure is isolated to one channel', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'shared-auth-site',
      url: 'https://shared-auth-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const backupSite = await db.insert(schema.sites).values({
      name: 'backup-auth-site',
      url: 'https://backup-auth-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const primaryAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'shared-auth-primary',
      accessToken: 'access-primary',
      apiToken: 'sk-primary',
      status: 'active',
      unitCost: 1,
    }).returning().get();
    const siblingAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'shared-auth-sibling',
      accessToken: 'access-sibling',
      apiToken: 'sk-sibling',
      status: 'active',
      unitCost: 1,
    }).returning().get();
    const backupAccount = await db.insert(schema.accounts).values({
      siteId: backupSite.id,
      username: 'shared-auth-backup',
      accessToken: 'access-backup',
      apiToken: 'sk-backup',
      status: 'active',
      unitCost: 1,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-auth-shared',
      enabled: true,
    }).returning().get();

    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: primaryAccount.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const siblingChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: siblingAccount.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const backupChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: backupAccount.id,
      tokenId: null,
      priority: 10,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(primaryChannel.id, { status: 401, errorText: 'invalid api key', modelName: 'gpt-auth-shared' });
    await router.recordFailure(primaryChannel.id, { status: 401, errorText: 'invalid api key', modelName: 'gpt-auth-shared' });

    const decision = await router.explainSelection('gpt-auth-shared');
    const siblingCandidate = decision.candidates.find((candidate) => candidate.channelId === siblingChannel.id);
    const backupCandidate = decision.candidates.find((candidate) => candidate.channelId === backupChannel.id);
    const primaryCandidate = decision.candidates.find((candidate) => candidate.channelId === primaryChannel.id);

    expect(decision.selectedChannelId).toBe(siblingChannel.id);
    expect(primaryCandidate?.eligible).toBe(false);
    expect(primaryCandidate?.reason || '').toContain('模型熔断');
    expect(primaryCandidate?.modelCircuitStatus?.isOpen).toBe(true);
    expect(siblingCandidate?.eligible).toBe(true);
    expect(siblingCandidate?.circuitStatus?.isOpen).toBe(false);
    expect(backupCandidate?.eligible).toBe(true);
  });

  it('keeps protocol mismatch recoverable without opening a model circuit', async () => {
    const primarySite = await db.insert(schema.sites).values({
      name: 'protocol-primary',
      url: 'https://protocol-primary.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const backupSite = await db.insert(schema.sites).values({
      name: 'protocol-backup',
      url: 'https://protocol-backup.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const primaryAccount = await db.insert(schema.accounts).values({
      siteId: primarySite.id,
      username: 'protocol-user-primary',
      accessToken: 'access-protocol-primary',
      apiToken: 'sk-protocol-primary',
      status: 'active',
      unitCost: 1,
    }).returning().get();
    const backupAccount = await db.insert(schema.accounts).values({
      siteId: backupSite.id,
      username: 'protocol-user-backup',
      accessToken: 'access-protocol-backup',
      apiToken: 'sk-protocol-backup',
      status: 'active',
      unitCost: 1,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.2-codex',
      enabled: true,
    }).returning().get();

    const primaryChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: primaryAccount.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const backupChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: backupAccount.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const fallbackRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: fallbackRoute.id,
      accountId: primaryAccount.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const router = new TokenRouter();
    await router.recordFailure(primaryChannel.id, {
      status: 400,
      errorText: 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.',
      modelName: 'gpt-5.2-codex',
    });

    const decision = await router.explainSelection('gpt-5.2-codex');
    const primaryCandidate = decision.candidates.find((candidate) => candidate.channelId === primaryChannel.id);
    const backupCandidate = decision.candidates.find((candidate) => candidate.channelId === backupChannel.id);

    expect(primaryCandidate?.eligible).toBe(false);
    expect(primaryCandidate?.reason || '').not.toContain('模型熔断');
    expect(primaryCandidate?.modelCircuitStatus?.isOpen).toBe(false);
    expect(backupCandidate?.eligible).toBe(true);

    const otherModelSelection = await router.selectChannel('gpt-4o-mini');
    expect(otherModelSelection?.account.id).toBe(primaryAccount.id);
  });
});
