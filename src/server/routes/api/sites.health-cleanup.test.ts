import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('sites health and cleanup routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-health-cleanup-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    const taskModule = await import('../../services/backgroundTaskService.js');
    taskModule.__resetBackgroundTasksForTests();
    await db.delete(schema.events).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('refreshes site health synchronously when wait=true', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/health/refresh',
      payload: { wait: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      summary: { total: number; alive: number; unreachable: number };
      results: unknown[];
    };
    expect(body.success).toBe(true);
    expect(body.summary.total).toBe(0);
    expect(body.summary.alive).toBe(0);
    expect(body.summary.unreachable).toBe(0);
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('queues background site health refresh task', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/health/refresh',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      queued: boolean;
      reused: boolean;
      jobId: string;
      status: string;
    };
    expect(body.success).toBe(true);
    expect(body.queued).toBe(true);
    expect(body.reused).toBe(false);
    expect(body.jobId.length).toBeGreaterThan(8);
    expect(['pending', 'running', 'succeeded']).toContain(body.status);
  });

  it('supports dry-run cleanup synchronously when wait=true', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/cleanup-unreachable',
      payload: { wait: true, dryRun: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      summary: { checkedSites: number; unreachableSites: number; removedSites: number; removedAccounts: number; dryRun: boolean };
      unreachableSites: unknown[];
      removedSiteIds: number[];
    };
    expect(body.success).toBe(true);
    expect(body.summary.checkedSites).toBe(0);
    expect(body.summary.unreachableSites).toBe(0);
    expect(body.summary.removedSites).toBe(0);
    expect(body.summary.removedAccounts).toBe(0);
    expect(body.summary.dryRun).toBe(true);
    expect(Array.isArray(body.unreachableSites)).toBe(true);
    expect(Array.isArray(body.removedSiteIds)).toBe(true);
  });

  it('persists unreachable site runtime health after refresh', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'unreachable-site',
      url: 'https://unreachable.invalid',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/health/refresh',
      payload: { wait: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      summary: { total: number; unreachable: number };
    };
    expect(body.success).toBe(true);
    expect(body.summary.total).toBe(1);
    expect(body.summary.unreachable).toBe(1);

    const refreshedSite = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
    expect(refreshedSite?.healthStatus).toBe('unreachable');
    expect((refreshedSite?.healthReason || '').length).toBeGreaterThan(0);
    expect((refreshedSite?.healthCheckedAt || '').length).toBeGreaterThan(0);
  });
});
