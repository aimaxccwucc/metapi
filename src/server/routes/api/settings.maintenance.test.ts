import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

const refreshModelsAndRebuildRoutesMock = vi.fn();

vi.mock('../../services/modelService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/modelService.js')>('../../services/modelService.js');
  return {
    ...actual,
    refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
  };
});

type DbModule = typeof import('../../db/index.js');

describe('settings maintenance custom routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-maintenance-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const settingsRoutesModule = await import('./settings.js');
    const customRoutesModule = await import('../../custom/register.js');

    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
    await app.register(customRoutesModule.registerCustomRoutes);
  });

  beforeEach(async () => {
    refreshModelsAndRebuildRoutesMock.mockReset();
    const taskModule = await import('../../services/backgroundTaskService.js');
    taskModule.__resetBackgroundTasksForTests();
    await db.delete(schema.events).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('queues cache clearing and route rebuild through custom settings routes', async () => {
    refreshModelsAndRebuildRoutesMock.mockImplementation(() => new Promise(() => {}));

    await db.insert(schema.modelAvailability).values({
      accountId: 1,
      modelName: 'gpt-4.1',
      available: true,
    }).run().catch(() => {});

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/maintenance/clear-cache',
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as {
      success: boolean;
      queued: boolean;
      reused: boolean;
      jobId: string;
      deletedModelAvailability: number;
      deletedRouteChannels: number;
      deletedTokenRoutes: number;
    };
    expect(body.success).toBe(true);
    expect(body.queued).toBe(true);
    expect(body.reused).toBe(false);
    expect(body.jobId.length).toBeGreaterThan(8);
    expect(typeof body.deletedModelAvailability).toBe('number');
    expect(typeof body.deletedRouteChannels).toBe('number');
    expect(typeof body.deletedTokenRoutes).toBe('number');
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(1);
  });

  it('clears usage stats and appends a settings event', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Usage Site',
      url: 'https://usage.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'session-token',
      balanceUsed: 42,
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-maintenance-token',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
      successCount: 3,
      failCount: 2,
      totalLatencyMs: 1234,
      totalCost: 9.99,
      lastUsedAt: '2026-03-15T00:00:00.000Z',
      lastFailAt: '2026-03-15T00:00:00.000Z',
      cooldownUntil: '2026-03-16T00:00:00.000Z',
    }).run();

    await db.insert(schema.proxyLogs).values({
      accountId: account.id,
      status: 'success',
      modelRequested: 'gpt-4.1',
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/maintenance/clear-usage',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { success: boolean; deletedProxyLogs: number; message: string };
    expect(body.success).toBe(true);
    expect(body.deletedProxyLogs).toBe(1);
    expect(body.message).toBe('占用统计已清理');

    const refreshedAccount = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(refreshedAccount?.balanceUsed).toBe(0);

    const refreshedChannel = await db.select().from(schema.routeChannels).get();
    expect(refreshedChannel).toMatchObject({
      successCount: 0,
      failCount: 0,
      totalLatencyMs: 0,
      totalCost: 0,
      lastUsedAt: null,
      lastFailAt: null,
      cooldownUntil: null,
    });

    const events = await db.select().from(schema.events).all();
    expect(events.some((event) => event.title === '占用统计与使用日志已清理')).toBe(true);
  });
});
