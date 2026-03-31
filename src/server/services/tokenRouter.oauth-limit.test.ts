import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter oauth usage-limit cooldown fanout', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-oauth-limit-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    delete process.env.DATA_DIR;
  });

  it('fans out usage_limit_reached cooldown to channels sharing the same oauth credential scope', async () => {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.2-codex',
      enabled: true,
    }).returning().get();

    const siteA = await db.insert(schema.sites).values({
      name: 'codex-limit-a',
      url: 'https://codex-limit-a.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const siteB = await db.insert(schema.sites).values({
      name: 'codex-limit-b',
      url: 'https://codex-limit-b.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const extraConfig = JSON.stringify({
      oauth: {
        provider: 'codex',
        accountId: 'shared-codex-account',
        accountKey: 'shared-codex-account',
      },
    });

    const accountA = await db.insert(schema.accounts).values({
      siteId: siteA.id,
      username: 'limit-a',
      accessToken: 'access-a',
      status: 'active',
      extraConfig,
    }).returning().get();

    const accountB = await db.insert(schema.accounts).values({
      siteId: siteB.id,
      username: 'limit-b',
      accessToken: 'access-b',
      status: 'active',
      extraConfig,
    }).returning().get();

    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channelA.id, {
      status: 429,
      errorText: JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          resets_in_seconds: 120,
          message: 'quota exceeded',
        },
      }),
      modelName: 'gpt-5.2-codex',
    });

    const rows = await db.select({
      id: schema.routeChannels.id,
      cooldownUntil: schema.routeChannels.cooldownUntil,
      failCount: schema.routeChannels.failCount,
      consecutiveFailCount: schema.routeChannels.consecutiveFailCount,
    }).from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, [channelA.id, channelB.id]))
      .all();

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.id === channelA.id || row.id === channelB.id).toBe(true);
      expect(typeof row.cooldownUntil).toBe('string');
      expect(Date.parse(String(row.cooldownUntil))).toBeGreaterThan(Date.now());
      expect(row.failCount ?? 0).toBe(0);
      expect(row.consecutiveFailCount ?? 0).toBe(0);
    }

    const selected = await router.selectChannel('gpt-5.2-codex');
    expect(selected).toBeNull();
  });

  it('does not fan out ordinary auth failures across oauth siblings', async () => {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.2-codex',
      enabled: true,
    }).returning().get();

    const site = await db.insert(schema.sites).values({
      name: 'codex-auth-site',
      url: 'https://codex-auth-site.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const extraConfig = JSON.stringify({
      oauth: {
        provider: 'codex',
        accountId: 'auth-shared-account',
        accountKey: 'auth-shared-account',
      },
    });

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'auth-a',
      accessToken: 'auth-access-a',
      status: 'active',
      extraConfig,
    }).returning().get();

    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'auth-b',
      accessToken: 'auth-access-b',
      status: 'active',
      extraConfig,
    }).returning().get();

    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channelA.id, {
      status: 401,
      errorText: 'expired token',
      modelName: 'gpt-5.2-codex',
    });

    const rowA = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelA.id)).get();
    const rowB = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelB.id)).get();

    expect(rowA?.cooldownUntil).toBeTruthy();
    expect(rowB?.cooldownUntil ?? null).toBeNull();
  });
});
