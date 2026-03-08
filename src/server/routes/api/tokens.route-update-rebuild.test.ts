import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('PUT /api/routes/:id route rebuild', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  const seedAccountWithToken = async (modelName: string) => {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `site-${id}`,
      url: `https://example.com/${id}`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${id}`,
      accessToken: `access-${id}`,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `token-${id}`,
      token: `sk-token-${id}`,
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName,
      available: true,
    }).run();

    return { site, account, token };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-update-rebuild-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    seedId = 0;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('rebuilds only automatic channels when modelPattern changes', async () => {
    const oldCandidate = await seedAccountWithToken('claude-opus-4-5');
    const newCandidate = await seedAccountWithToken('gemini-2.0-flash');
    const manualCandidate = await seedAccountWithToken('manual-special');

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-.*$',
      displayName: 'old-group',
      enabled: true,
    }).returning().get();

    const autoChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: oldCandidate.account.id,
      tokenId: oldCandidate.token.id,
      sourceModel: 'claude-opus-4-5',
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const manualChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: manualCandidate.account.id,
      tokenId: manualCandidate.token.id,
      sourceModel: 'manual-special',
      priority: 7,
      weight: 3,
      enabled: true,
      manualOverride: true,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/routes/${route.id}`,
      payload: {
        modelPattern: 're:^gemini-.*$',
        displayName: 'new-group',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: route.id,
      modelPattern: 're:^gemini-.*$',
      displayName: 'new-group',
    });

    const routeChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, route.id))
      .all();

    expect(routeChannels.some((channel) => channel.id === manualChannel.id)).toBe(true);
    expect(routeChannels.some((channel) => channel.id === autoChannel.id)).toBe(false);

    const rebuiltAuto = routeChannels.find((channel) =>
      channel.accountId === newCandidate.account.id
      && channel.tokenId === newCandidate.token.id
      && channel.sourceModel === 'gemini-2.0-flash',
    );

    expect(rebuiltAuto).toBeDefined();
    expect(rebuiltAuto?.manualOverride).toBe(false);
    expect(rebuiltAuto?.priority).toBe(0);
    expect(rebuiltAuto?.weight).toBe(10);
  });
});
