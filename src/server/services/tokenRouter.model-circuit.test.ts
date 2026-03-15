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
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-circuit-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
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
    await router.recordFailure(channelA.id, { status: 401, upstreamErrorText: 'unauthorized', modelName: 'claude-opus-4-6' });

    const opusDecision = await router.explainSelection('claude-opus-4-6');
    const channelACandidate = opusDecision.candidates.find((candidate) => candidate.channelId === channelA.id);
    const channelBCandidate = opusDecision.candidates.find((candidate) => candidate.channelId === channelB.id);

    expect(channelACandidate?.eligible).toBe(false);
    expect(channelACandidate?.reason || '').toContain('模型熔断');
    expect(channelBCandidate?.eligible).toBe(true);

    const otherModelSelection = await router.selectChannel('gpt-4o-mini');
    expect(otherModelSelection?.account.id).toBe(accountA.id);
  });
});
