import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { eq } from 'drizzle-orm';

const getApiTokensMock = vi.fn();
const getApiTokenMock = vi.fn();
const createApiTokenMock = vi.fn();
const getModelsMock = vi.fn();
const getUserGroupsMock = vi.fn();
const resolvePreferredTokenGroupMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    createApiToken: (...args: unknown[]) => createApiTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
    getUserGroups: (...args: unknown[]) => getUserGroupsMock(...args),
  }),
}));

vi.mock('../../services/modelPricingService.js', async () => {
  const actual = await vi.importActual('../../services/modelPricingService.js') as Record<string, unknown>;
  return {
    ...actual,
    resolvePreferredTokenGroup: (...args: unknown[]) => resolvePreferredTokenGroupMock(...args),
  };
});

type DbModule = typeof import('../../db/index.js');

describe('PUT /api/channels/batch', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  const seedChannel = async (options: { priority: number; weight: number; manualOverride?: boolean }) => {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `site-${id}`,
      url: `https://example.com/${id}`,
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: `access-token-${id}`,
      apiToken: `api-token-${id}`,
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: `gpt-4o-${id}`,
      enabled: true,
    }).returning().get();

    return await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      priority: options.priority,
      weight: options.weight,
      manualOverride: options.manualOverride ?? false,
    }).returning().get();
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-tokens-batch-'));
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
    getApiTokensMock.mockReset();
    getApiTokenMock.mockReset();
    createApiTokenMock.mockReset();
    getModelsMock.mockReset();
    getUserGroupsMock.mockReset();
    resolvePreferredTokenGroupMock.mockReset();
    getApiTokensMock.mockResolvedValue([]);
    getApiTokenMock.mockResolvedValue(null);
    createApiTokenMock.mockResolvedValue(false);
    getModelsMock.mockResolvedValue([]);
    getUserGroupsMock.mockResolvedValue(['default']);
    resolvePreferredTokenGroupMock.mockResolvedValue({ group: 'default', availableGroups: ['default'], candidateGroups: ['default'], groupRatios: { default: 1 }, catalog: null });
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 400 when updates is missing or empty', async () => {
    const missingRes = await app.inject({
      method: 'PUT',
      url: '/api/channels/batch',
      payload: {},
    });
    expect(missingRes.statusCode).toBe(400);
    expect(missingRes.json()).toMatchObject({ success: false });

    const emptyRes = await app.inject({
      method: 'PUT',
      url: '/api/channels/batch',
      payload: { updates: [] },
    });
    expect(emptyRes.statusCode).toBe(400);
    expect(emptyRes.json()).toMatchObject({ success: false });
  });

  it('returns 400 when an update item is invalid', async () => {
    const invalidIdRes = await app.inject({
      method: 'PUT',
      url: '/api/channels/batch',
      payload: {
        updates: [{ id: '1', priority: 1 }],
      },
    });
    expect(invalidIdRes.statusCode).toBe(400);
    expect(invalidIdRes.json()).toMatchObject({ success: false });

    const invalidPriorityRes = await app.inject({
      method: 'PUT',
      url: '/api/channels/batch',
      payload: {
        updates: [{ id: 1, priority: null }],
      },
    });
    expect(invalidPriorityRes.statusCode).toBe(400);
    expect(invalidPriorityRes.json()).toMatchObject({ success: false });
  });

  it('updates priorities in batch, sets manualOverride, and keeps weight unchanged', async () => {
    const channelA = await seedChannel({ priority: 9, weight: 17, manualOverride: false });
    const channelB = await seedChannel({ priority: 8, weight: 23, manualOverride: false });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/channels/batch',
      payload: {
        updates: [
          { id: channelA.id, priority: 3.8 },
          { id: channelB.id, priority: -7.2 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      channels: Array<{ id: number; priority: number; weight: number; manualOverride: boolean }>;
    };
    expect(body.success).toBe(true);
    expect(body.channels).toHaveLength(2);

    const returnedA = body.channels.find((channel) => channel.id === channelA.id);
    const returnedB = body.channels.find((channel) => channel.id === channelB.id);
    expect(returnedA).toBeDefined();
    expect(returnedB).toBeDefined();
    expect(returnedA?.priority).toBe(3);
    expect(returnedB?.priority).toBe(0);
    expect(returnedA?.weight).toBe(17);
    expect(returnedB?.weight).toBe(23);
    expect(returnedA?.manualOverride).toBe(true);
    expect(returnedB?.manualOverride).toBe(true);

    const dbA = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelA.id)).get();
    const dbB = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelB.id)).get();
    expect(dbA?.priority).toBe(3);
    expect(dbB?.priority).toBe(0);
    expect(dbA?.weight).toBe(17);
    expect(dbB?.weight).toBe(23);
    expect(dbA?.manualOverride).toBe(true);
    expect(dbB?.manualOverride).toBe(true);
  });

  it('auto-creates account keys for missing-token accounts when batch adding route channels', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'auto-key-site',
      url: 'https://auto-key-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'missing-token-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.2-codex',
      enabled: true,
    }).returning().get();

    getApiTokensMock.mockResolvedValue([{ name: 'default', key: 'sk-created', enabled: true, tokenGroup: 'default' }]);
    getApiTokenMock.mockResolvedValue(null);
    createApiTokenMock.mockResolvedValue(true);
    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (credential === 'session-token' || credential === 'sk-created') {
        return ['gpt-5.2-codex'];
      }
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels/batch`,
      payload: {
        channels: [
          { accountId: account.id, sourceModel: 'gpt-5.2-codex' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, created: 1, skipped: 0, errors: [] });

    const tokens = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, account.id)).all();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.token).toBe('sk-created');

    const routeChannels = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.routeId, route.id)).all();
    expect(routeChannels).toHaveLength(1);
    expect(routeChannels[0]?.accountId).toBe(account.id);
    expect(routeChannels[0]?.tokenId ?? null).toBeNull();
    expect(routeChannels[0]?.sourceModel).toBe('gpt-5.2-codex');
    expect(routeChannels[0]?.manualOverride).toBe(true);
  });

  it('auto-creates token in lowest-ratio group when route create sees missing groups', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'group-ratio-site',
      url: 'https://group-ratio-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'group-ratio-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'kimi-k2.5',
      available: true,
    }).run();

    getUserGroupsMock.mockResolvedValue(['default', 'vip']);
    resolvePreferredTokenGroupMock.mockResolvedValue({
      group: 'vip',
      availableGroups: ['default', 'vip'],
      candidateGroups: ['default', 'vip'],
      groupRatios: { default: 1, vip: 0.25 },
      catalog: null,
    });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'metapi-vip-kimi-k2-5', key: 'sk-vip-created', enabled: true, tokenGroup: 'vip' },
    ]);
    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (credential === 'session-token' || credential === 'sk-vip-created') {
        return ['kimi-k2.5'];
      }
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'kimi-k2.5',
        enabled: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(createApiTokenMock.mock.calls[0]?.[3]).toMatchObject({ group: 'vip' });

    const tokens = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, account.id)).all();
    expect(tokens.some((item: { token: string | null; tokenGroup: string | null }) => item.token === 'sk-vip-created' && item.tokenGroup === 'vip')).toBe(true);

    const route = response.json() as { id: number };
    const channels = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.routeId, route.id)).all();
    expect(channels.length).toBeGreaterThan(0);
    expect(channels[0]?.sourceModel).toBe('kimi-k2.5');
  });

  it('reuses account warmup work for repeated entries in the same batch', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'warmup-site',
      url: 'https://warmup-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'warmup-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^gpt-5.2-codex$',
      enabled: true,
    }).returning().get();

    getApiTokensMock.mockResolvedValue([{ name: 'default', key: 'sk-created', enabled: true, tokenGroup: 'default' }]);
    getApiTokenMock.mockResolvedValue(null);
    createApiTokenMock.mockResolvedValue(true);
    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (credential === 'session-token' || credential === 'sk-created') {
        return ['gpt-5.2-codex'];
      }
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels/batch`,
      payload: {
        channels: [
          { accountId: account.id, sourceModel: 'gpt-5.2-codex' },
          { accountId: account.id, sourceModel: 'gpt-5.2-codex' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, created: 1, skipped: 1, errors: [] });
    expect(getApiTokensMock).toHaveBeenCalledTimes(1);
    expect(getModelsMock).toHaveBeenCalledTimes(3);
    expect(createApiTokenMock).not.toHaveBeenCalled();
  });
});
