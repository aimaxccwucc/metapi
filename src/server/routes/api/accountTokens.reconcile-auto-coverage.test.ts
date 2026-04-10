import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const reconcileHistoricalSharedGroupAutoTokensMock = vi.fn();

vi.mock('../../services/tokenCoverageAutoProvisionService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/tokenCoverageAutoProvisionService.js')>('../../services/tokenCoverageAutoProvisionService.js');
  return {
    ...actual,
    reconcileHistoricalSharedGroupAutoTokens: (...args: unknown[]) => reconcileHistoricalSharedGroupAutoTokensMock(...args),
  };
});

type DbModule = typeof import('../../db/index.js');

describe('account token auto coverage reconcile route', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-token-reconcile-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accountTokens.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountTokensRoutes);
  });

  beforeEach(async () => {
    reconcileHistoricalSharedGroupAutoTokensMock.mockReset();
    reconcileHistoricalSharedGroupAutoTokensMock.mockResolvedValue({
      accountsScanned: 3,
      accountsWithExplicitTargets: 2,
      accountsWithoutExplicitTargets: 1,
      provisionSummary: {
        total: 4,
        created: 1,
        reused: 2,
        skipped: 0,
        cooldown: 0,
        failed: 1,
      },
    });
    const taskModule = await import('../../services/backgroundTaskService.js');
    taskModule.__resetBackgroundTasksForTests();
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('runs reconcile synchronously when wait=true', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/reconcile-auto-coverage',
      payload: { wait: true },
    });

    expect(response.statusCode).toBe(200);
    expect(reconcileHistoricalSharedGroupAutoTokensMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      success: true,
      accountsScanned: 3,
      accountsWithExplicitTargets: 2,
      accountsWithoutExplicitTargets: 1,
      provisionSummary: {
        created: 1,
        reused: 2,
        failed: 1,
      },
    });
  });

  it('dedupes queued reconcile task while one is still running', async () => {
    let resolveFirstRun: (value: unknown) => void = () => {};
    const firstRun = new Promise((resolve) => {
      resolveFirstRun = resolve;
    });
    reconcileHistoricalSharedGroupAutoTokensMock.mockImplementation(() => firstRun);

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/reconcile-auto-coverage',
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
      url: '/api/account-tokens/reconcile-auto-coverage',
      payload: {},
    });
    expect(secondResponse.statusCode).toBe(202);
    const secondBody = secondResponse.json() as { reused: boolean; jobId: string };
    expect(secondBody.reused).toBe(true);
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(reconcileHistoricalSharedGroupAutoTokensMock).toHaveBeenCalledTimes(1);

    resolveFirstRun({
      accountsScanned: 0,
      accountsWithExplicitTargets: 0,
      accountsWithoutExplicitTargets: 0,
      provisionSummary: {
        total: 0,
        created: 0,
        reused: 0,
        skipped: 0,
        cooldown: 0,
        failed: 0,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
