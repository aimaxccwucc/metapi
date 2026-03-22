import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executeRefreshSiteReachabilityMock = vi.fn();
const executeCleanupUnreachableSitesMock = vi.fn();

vi.mock('../../services/siteHealthService.js', () => ({
  executeRefreshSiteReachability: (...args: unknown[]) => executeRefreshSiteReachabilityMock(...args),
  executeCleanupUnreachableSites: (...args: unknown[]) => executeCleanupUnreachableSitesMock(...args),
}));

type DbModule = typeof import('../../db/index.js');
type BackgroundTaskModule = typeof import('../../services/backgroundTaskService.js');

describe('site ops routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let resetBackgroundTasks: BackgroundTaskModule['__resetBackgroundTasksForTests'] | null = null;
  let getBackgroundTask: BackgroundTaskModule['getBackgroundTask'] | null = null;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-ops-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./siteOps.js');
    const backgroundTaskModule = await import('../../services/backgroundTaskService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    resetBackgroundTasks = backgroundTaskModule.__resetBackgroundTasksForTests;
    getBackgroundTask = backgroundTaskModule.getBackgroundTask;

    app = Fastify();
    await app.register(routesModule.registerSiteOpsRoutes);
  });

  beforeEach(async () => {
    executeRefreshSiteReachabilityMock.mockReset();
    executeCleanupUnreachableSitesMock.mockReset();
    resetBackgroundTasks?.();
    await db.delete(schema.events).run();
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
    delete process.env.DATA_DIR;
  });

  it('supports synchronous site reachability refresh when wait is enabled', async () => {
    executeRefreshSiteReachabilityMock.mockResolvedValueOnce({
      summary: {
        total: 1,
        alive: 1,
        unreachable: 0,
        accountCountOnUnreachableSites: 0,
      },
      results: [{
        siteId: 1,
        siteName: 'Demo Site',
        siteUrl: 'https://demo.example.com',
        accountCount: 2,
        alive: true,
        reason: 'HTTP 200',
        checkedUrl: 'https://demo.example.com/',
        statusCode: 200,
        checkedAt: '2026-03-22T00:00:00.000Z',
      }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/health/refresh',
      payload: { wait: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      summary: {
        total: 1,
        alive: 1,
        unreachable: 0,
      },
      results: [{
        siteId: 1,
        siteName: 'Demo Site',
        alive: true,
      }],
    });
    expect(executeRefreshSiteReachabilityMock).toHaveBeenCalledTimes(1);
  });

  it('queues and reuses the background site reachability refresh task', async () => {
    let resolveRefresh: ((value: unknown) => void) | null = null;
    executeRefreshSiteReachabilityMock.mockImplementation(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/sites/health/refresh',
      payload: {},
    });
    expect(firstResponse.statusCode).toBe(200);
    const firstBody = firstResponse.json() as {
      success: boolean;
      queued: boolean;
      reused: boolean;
      jobId: string;
    };
    expect(firstBody).toMatchObject({
      success: true,
      queued: true,
      reused: false,
    });
    expect(typeof firstBody.jobId).toBe('string');
    expect(getBackgroundTask?.(firstBody.jobId)).toMatchObject({
      status: expect.stringMatching(/pending|running/),
    });

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/sites/health/refresh',
      payload: {},
    });
    expect(secondResponse.statusCode).toBe(200);
    const secondBody = secondResponse.json() as {
      reused: boolean;
      jobId: string;
    };
    expect(secondBody.reused).toBe(true);
    expect(secondBody.jobId).toBe(firstBody.jobId);

    resolveRefresh?.({
      summary: {
        total: 0,
        alive: 0,
        unreachable: 0,
        accountCountOnUnreachableSites: 0,
      },
      results: [],
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const task = getBackgroundTask?.(firstBody.jobId);
      if (task?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(getBackgroundTask?.(firstBody.jobId)).toMatchObject({
      status: 'succeeded',
    });
  });

  it('passes the dry-run flag through unreachable-site cleanup', async () => {
    executeCleanupUnreachableSitesMock.mockResolvedValueOnce({
      summary: {
        checkedSites: 2,
        unreachableSites: 1,
        removedSites: 0,
        removedAccounts: 0,
        dryRun: true,
      },
      unreachableSites: [{
        siteId: 2,
        siteName: 'Dead Site',
        siteUrl: 'https://dead.example.com',
        accountCount: 3,
        alive: false,
        reason: 'timeout',
        checkedUrl: 'https://dead.example.com/',
        statusCode: null,
        checkedAt: '2026-03-22T00:00:00.000Z',
      }],
      removedSiteIds: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/cleanup-unreachable',
      payload: { wait: true, dryRun: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      summary: {
        checkedSites: 2,
        unreachableSites: 1,
        removedSites: 0,
        dryRun: true,
      },
    });
    expect(executeCleanupUnreachableSitesMock).toHaveBeenCalledWith(true);
  });
});
