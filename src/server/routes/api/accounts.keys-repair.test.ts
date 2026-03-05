import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repairAllAccountKeysMock = vi.fn();

vi.mock('../../services/accountKeyRepairService.js', () => ({
  repairAllAccountKeys: (...args: unknown[]) => repairAllAccountKeysMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts keys repair route', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-keys-repair-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    repairAllAccountKeysMock.mockReset();
    const taskModule = await import('../../services/backgroundTaskService.js');
    taskModule.__resetBackgroundTasksForTests();
    db.delete(schema.events).run();
    db.delete(schema.routeChannels).run();
    db.delete(schema.tokenRoutes).run();
    db.delete(schema.tokenModelAvailability).run();
    db.delete(schema.modelAvailability).run();
    db.delete(schema.checkinLogs).run();
    db.delete(schema.accountTokens).run();
    db.delete(schema.accounts).run();
    db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('runs repair synchronously when wait=true', async () => {
    repairAllAccountKeysMock.mockResolvedValueOnce({
      summary: {
        total: 2,
        eligible: 2,
        alreadyOk: 1,
        repaired: 1,
        created: 0,
        synced: 0,
        skipped: 0,
        failed: 0,
      },
      results: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/keys/repair',
      payload: { wait: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { success: boolean; summary: { repaired: number; alreadyOk: number } };
    expect(body.success).toBe(true);
    expect(body.summary.repaired).toBe(1);
    expect(body.summary.alreadyOk).toBe(1);
    expect(repairAllAccountKeysMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes queued repair task while one is still running', async () => {
    let resolveFirstRun: (value: unknown) => void = () => {};
    const firstRun = new Promise((resolve) => {
      resolveFirstRun = resolve;
    });
    repairAllAccountKeysMock.mockImplementation(() => firstRun);

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/accounts/keys/repair',
      payload: {},
    });
    expect(firstResponse.statusCode).toBe(202);
    const firstBody = firstResponse.json() as { success: boolean; queued: boolean; reused: boolean; jobId: string };
    expect(firstBody.success).toBe(true);
    expect(firstBody.queued).toBe(true);
    expect(firstBody.reused).toBe(false);
    expect(firstBody.jobId.length).toBeGreaterThan(8);

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/accounts/keys/repair',
      payload: {},
    });
    expect(secondResponse.statusCode).toBe(202);
    const secondBody = secondResponse.json() as { reused: boolean; jobId: string };
    expect(secondBody.reused).toBe(true);
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(repairAllAccountKeysMock).toHaveBeenCalledTimes(1);

    resolveFirstRun({
      summary: {
        total: 0,
        eligible: 0,
        alreadyOk: 0,
        repaired: 0,
        created: 0,
        synced: 0,
        skipped: 0,
        failed: 0,
      },
      results: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
