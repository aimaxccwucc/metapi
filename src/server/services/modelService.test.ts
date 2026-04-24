import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('rebuildTokenRoutesFromAvailability', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let rebuildTokenRoutesFromAvailability: ModelServiceModule['rebuildTokenRoutesFromAvailability'];
  let rebuildTokenRoutesFromAvailabilityScoped: ModelServiceModule['rebuildTokenRoutesFromAvailabilityScoped'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    rebuildTokenRoutesFromAvailability = modelService.rebuildTokenRoutesFromAvailability;
    rebuildTokenRoutesFromAvailabilityScoped = modelService.rebuildTokenRoutesFromAvailabilityScoped;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('syncs an existing exact manual route with an account-direct channel for apikey model availability', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'apikey-site',
      url: 'https://apikey-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-user',
      accessToken: '',
      apiToken: 'sk-apikey-route',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.2-codex',
      available: true,
      latencyMs: 1200,
      checkedAt: '2026-03-08T08:00:00.000Z',
    }).run();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.2-codex',
      probePolicy: 'manual',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);
    expect(rebuild.createdRoutes).toBe(0);

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
    expect(channels[0]?.manualOverride).toBe(false);
  });

  it('ignores hidden account_tokens for direct apikey connections when syncing existing routes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'apikey-legacy-site',
      url: 'https://apikey-legacy.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-legacy-user',
      accessToken: '',
      apiToken: 'sk-direct-credential',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const hiddenToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'legacy-hidden',
      token: 'sk-hidden-legacy-token',
      source: 'legacy',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 200,
      checkedAt: '2026-03-20T08:00:00.000Z',
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: hiddenToken.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 180,
      checkedAt: '2026-03-20T08:00:00.000Z',
    }).run();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4.1',
      probePolicy: 'manual',
      enabled: true,
    }).returning().get();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
  });

  it('syncs an existing exact manual route with an account-direct channel for oauth model availability', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'codex-site',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'codex-user@example.com',
      accessToken: 'oauth-access-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          provider: 'codex',
          accountId: 'chatgpt-account-123',
          email: 'codex-user@example.com',
          planType: 'team',
        },
      }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.2-codex',
      available: true,
      latencyMs: 320,
      checkedAt: '2026-03-17T00:00:00.000Z',
    }).run();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.2-codex',
      probePolicy: 'manual',
      enabled: true,
    }).returning().get();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const channels = await db.select().from(schema.routeChannels)
      .where(and(
        eq(schema.routeChannels.routeId, route.id),
        eq(schema.routeChannels.accountId, account.id),
      ))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]?.tokenId ?? null).toBeNull();
    expect(channels[0]?.manualOverride).toBe(false);
  });

  it('does not auto-create exact routes when no manual routes exist', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-no-routes',
      url: 'https://site-no-routes.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'no-routes-user',
      accessToken: '',
      apiToken: 'sk-no-routes',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 120,
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);
    expect(rebuild.createdRoutes).toBe(0);
    expect(rebuild.createdChannels).toBe(0);

    const routes = await db.select().from(schema.tokenRoutes).all();
    expect(routes).toHaveLength(0);
  });

  it('removes stale auto exact routes and keeps manual wildcard routes on rebuild', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-1',
      url: 'https://site-1.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-1',
      accessToken: 'access-1',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-test',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'latest-model',
      available: true,
    }).run();

    const staleRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'old-model',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: staleRoute.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const wildcardRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      probePolicy: 'manual',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: wildcardRoute.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);
    expect(rebuild.removedRoutes).toBe(1);

    const oldRoute = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, staleRoute.id)).get();
    expect(oldRoute).toBeUndefined();

    const oldChannels = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.routeId, staleRoute.id)).all();
    expect(oldChannels).toHaveLength(0);

    const latestRoute = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.modelPattern, 'latest-model')).get();
    expect(latestRoute).toBeUndefined();

    const wildcardRouteAfter = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, wildcardRoute.id)).get();
    expect(wildcardRouteAfter).toBeDefined();
  });

  it('syncs wildcard route channels for newly added matching tokens and removes stale automatic channels', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-pattern',
      url: 'https://site-pattern.example.com',
      platform: 'new-api',
    }).returning().get();

    const staleAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'stale-user',
      accessToken: 'stale-access',
      status: 'active',
    }).returning().get();

    const staleToken = await db.insert(schema.accountTokens).values({
      accountId: staleAccount.id,
      name: 'stale-token',
      token: 'sk-stale',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const activeAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'active-user',
      accessToken: 'active-access',
      status: 'active',
    }).returning().get();

    const activeToken = await db.insert(schema.accountTokens).values({
      accountId: activeAccount.id,
      name: 'active-token',
      token: 'sk-active',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: activeToken.id,
      modelName: 'gpt-4o-mini',
      available: true,
    }).run();

    const wildcardRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      probePolicy: 'manual',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: wildcardRoute.id,
        accountId: staleAccount.id,
        tokenId: staleToken.id,
        sourceModel: 'gpt-3.5-turbo',
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      },
      {
        routeId: wildcardRoute.id,
        accountId: staleAccount.id,
        tokenId: staleToken.id,
        sourceModel: 'legacy-special',
        priority: 9,
        weight: 2,
        enabled: true,
        manualOverride: true,
      },
    ]).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.createdChannels).toBeGreaterThanOrEqual(1);
    expect(rebuild.removedChannels).toBeGreaterThanOrEqual(1);

    const routeChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, wildcardRoute.id))
      .all();

    expect(routeChannels.some((channel) =>
      channel.accountId === activeAccount.id
      && channel.tokenId === activeToken.id
      && channel.sourceModel === 'gpt-4o-mini'
      && channel.manualOverride === false,
    )).toBe(true);

    expect(routeChannels.some((channel) =>
      channel.accountId === staleAccount.id
      && channel.tokenId === staleToken.id
      && channel.sourceModel === 'gpt-3.5-turbo',
    )).toBe(false);

    expect(routeChannels.some((channel) =>
      channel.accountId === staleAccount.id
      && channel.tokenId === staleToken.id
      && channel.sourceModel === 'legacy-special'
      && channel.manualOverride === true,
    )).toBe(true);
  });

  it('treats provider-prefixed aliases as eligible candidates for exact routes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'glm-alias-site',
      url: 'https://glm-alias-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'glm-alias-user',
      accessToken: 'glm-access',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'glm-token',
      token: 'sk-glm-alias',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'z-ai/glm-5.1',
      available: true,
    }).run();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'glm-5.1',
      probePolicy: 'manual',
      enabled: true,
    }).returning().get();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);

    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, route.id))
      .all();

    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'z-ai/glm-5.1',
    });
  });

  it('preserves exact source routes referenced by explicit groups and syncs their channels', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-grouped',
      url: 'https://site-grouped.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'group-user',
      accessToken: 'group-access',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'group-token',
      token: 'sk-group',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'claude-sonnet-4-5',
      available: true,
    }).run();

    const sourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-sonnet-4-5',
      enabled: true,
    }).returning().get();

    const groupRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-stable',
      displayName: 'claude-stable',
      routeMode: 'explicit_group',
      probePolicy: 'manual',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeGroupSources).values({
      groupRouteId: groupRoute.id,
      sourceRouteId: sourceRoute.id,
    }).run();

    const rebuild = await rebuildTokenRoutesFromAvailability();

    expect(rebuild.removedRoutes).toBe(0);

    const sourceRouteAfter = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, sourceRoute.id))
      .get();
    expect(sourceRouteAfter).toBeDefined();

    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, sourceRoute.id))
      .all();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.accountId).toBe(account.id);
    expect(channels[0]?.tokenId).toBe(token.id);
    expect(channels[0]?.sourceModel).toBe('claude-sonnet-4-5');
  });

  it('scoped rebuild only removes stale automatic channels for affected accounts', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-scoped',
      url: 'https://site-scoped.example.com',
      platform: 'new-api',
    }).returning().get();

    const staleAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'scoped-stale',
      accessToken: 'scoped-stale-access',
      status: 'active',
    }).returning().get();
    const healthyAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'scoped-healthy',
      accessToken: 'scoped-healthy-access',
      status: 'active',
    }).returning().get();

    const staleToken = await db.insert(schema.accountTokens).values({
      accountId: staleAccount.id,
      name: 'stale',
      token: 'sk-scoped-stale',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).returning().get();
    const healthyToken = await db.insert(schema.accountTokens).values({
      accountId: healthyAccount.id,
      name: 'healthy',
      token: 'sk-scoped-healthy',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: healthyToken.id,
      modelName: 'gpt-4.1-mini',
      available: true,
    }).run();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      probePolicy: 'manual',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: route.id,
        accountId: staleAccount.id,
        tokenId: staleToken.id,
        sourceModel: 'gpt-4.1-mini',
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      },
      {
        routeId: route.id,
        accountId: healthyAccount.id,
        tokenId: healthyToken.id,
        sourceModel: 'gpt-4.1-mini',
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      },
    ]).run();

    const rebuild = await rebuildTokenRoutesFromAvailabilityScoped({ accountIds: [staleAccount.id] });
    expect(rebuild.removedChannels).toBe(1);

    const remainingChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, route.id))
      .all();

    expect(remainingChannels.some((item) => item.accountId === staleAccount.id)).toBe(false);
    expect(remainingChannels.some((item) => item.accountId === healthyAccount.id && item.tokenId === healthyToken.id)).toBe(true);
  });
});
