import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repairAllAccountKeysMock = vi.fn();

vi.mock('../../services/accountKeyRepairService.js', () => ({
  repairAllAccountKeys: (...args: unknown[]) => repairAllAccountKeysMock(...args),
}));

type DbModule = typeof import('../../db/index.js');
type BackgroundTaskModule = typeof import('../../services/backgroundTaskService.js');

describe('account maintenance routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let resetBackgroundTasks: BackgroundTaskModule['__resetBackgroundTasksForTests'] | null = null;
  let getBackgroundTask: BackgroundTaskModule['getBackgroundTask'] | null = null;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-maintenance-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accountMaintenance.js');
    const backgroundTaskModule = await import('../../services/backgroundTaskService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    resetBackgroundTasks = backgroundTaskModule.__resetBackgroundTasksForTests;
    getBackgroundTask = backgroundTaskModule.getBackgroundTask;

    app = Fastify();
    await app.register(routesModule.registerAccountMaintenanceRoutes);
  });

  beforeEach(async () => {
    repairAllAccountKeysMock.mockReset();
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

  it('supports synchronous key repair when wait is enabled', async () => {
    repairAllAccountKeysMock.mockResolvedValueOnce({
      summary: {
        repaired: 1,
        created: 0,
        synced: 0,
        alreadyOk: 2,
        skipped: 1,
        failed: 0,
      },
      results: [{
        accountId: 1,
        accountName: 'alpha',
        siteName: 'site-a',
        status: 'repaired',
        message: 'default token repaired',
      }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/keys/repair',
      payload: { wait: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      summary: {
        repaired: 1,
        alreadyOk: 2,
        skipped: 1,
        failed: 0,
      },
    });
    expect(repairAllAccountKeysMock).toHaveBeenCalledTimes(1);
  });

  it('queues and reuses the background key-repair task', async () => {
    let resolveRepair: ((value: unknown) => void) | null = null;
    repairAllAccountKeysMock.mockImplementation(() => new Promise((resolve) => {
      resolveRepair = resolve;
    }));

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/accounts/keys/repair',
      payload: {},
    });

    expect(firstResponse.statusCode).toBe(202);
    const firstBody = firstResponse.json() as {
      success: boolean;
      queued: boolean;
      reused: boolean;
      jobId: string;
      message: string;
    };
    expect(firstBody).toMatchObject({
      success: true,
      queued: true,
      reused: false,
    });
    expect(firstBody.message).toContain('已开始账号 Key 一键修复');
    expect(getBackgroundTask?.(firstBody.jobId)).toMatchObject({
      status: expect.stringMatching(/pending|running/),
    });

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/accounts/keys/repair',
      payload: {},
    });

    expect(secondResponse.statusCode).toBe(202);
    const secondBody = secondResponse.json() as {
      reused: boolean;
      jobId: string;
      message: string;
    };
    expect(secondBody.reused).toBe(true);
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(secondBody.message).toContain('任务执行中');

    resolveRepair?.({
      summary: {
        repaired: 1,
        created: 1,
        synced: 0,
        alreadyOk: 0,
        skipped: 0,
        failed: 0,
      },
      results: [{
        accountId: 1,
        accountName: 'alpha',
        siteName: 'site-a',
        status: 'created',
        message: 'created default token',
      }],
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
});
