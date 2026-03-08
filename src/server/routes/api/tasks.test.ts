import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

describe('task routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-tasks-route-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tasks.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.taskRoutes);
  });

  beforeEach(async () => {
    const taskModule = await import('../../services/backgroundTaskService.js');
    taskModule.__resetBackgroundTasksForTests();
    await db.delete(schema.events).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });


  it('lists finished background tasks from /api/tasks', async () => {
    const { startBackgroundTask } = await import('../../services/backgroundTaskService.js');
    startBackgroundTask(
      {
        type: 'status',
        title: '测试任务列表',
      },
      async () => ({ ok: true }),
    );

    for (let i = 0; i < 20; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/tasks?limit=10',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { tasks?: Array<{ title?: string; status?: string }> };
      const matchedTask = Array.isArray(body.tasks)
        ? body.tasks.find((item) => item.title === '测试任务列表')
        : null;
      if (matchedTask) {
        expect(matchedTask.status).toBe('succeeded');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('task list did not return finished task in time');
  });

  it('enriches task result rows with site metadata for navigation', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Alpha Site',
      url: 'https://alpha.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      password: 'x',
      accessToken: 'session-token',
      apiToken: 'api-token',
      status: 'active',
      checkinEnabled: true,
    }).returning().get();

    const { startBackgroundTask } = await import('../../services/backgroundTaskService.js');
    const { task } = startBackgroundTask(
      {
        type: 'checkin',
        title: '测试签到任务',
      },
      async () => ({
        summary: { total: 1, success: 0, skipped: 0, failed: 1 },
        results: [
          {
            accountId: account.id,
            result: {
              success: false,
              status: 'failed',
              message: 'token expired',
            },
          },
        ],
      }),
    );

    for (let i = 0; i < 20; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { success: boolean; task: { status: string; result?: { results?: Array<Record<string, unknown>> } } };
      if (body.task.status === 'succeeded') {
        const row = body.task.result?.results?.[0] || {};
        expect(row.accountId).toBe(account.id);
        expect(row.siteId).toBe(site.id);
        expect(row.siteName).toBe('Alpha Site');
        expect(row.site).toBe('Alpha Site');
        expect(row.username).toBe('alice');
        expect(row.accountName).toBe('alice');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('task did not finish in time');
  });
});
