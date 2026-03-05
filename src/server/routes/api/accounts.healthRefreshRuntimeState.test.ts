import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const refreshBalanceMock = vi.fn();

vi.mock('../../services/balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts health refresh runtime state', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-health-refresh-'));
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
    refreshBalanceMock.mockReset();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('keeps degraded runtime state for unsupported checkin after health refresh', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Wind Hub',
      url: 'https://windhub.cc',
      platform: 'done-hub',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'ld6jl3djexjf',
      accessToken: 'token',
      status: 'active',
      extraConfig: JSON.stringify({
        runtimeHealth: {
          state: 'degraded',
          reason: '站点不支持签到接口',
          source: 'checkin',
          checkedAt: '2026-02-25T18:00:00.000Z',
        },
      }),
    }).returning().get();

    refreshBalanceMock.mockResolvedValueOnce({ balance: 100, used: 0, quota: 100 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/health/refresh',
      payload: { accountId: account.id, wait: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      summary: {
        healthy: number;
        degraded: number;
        failed: number;
      };
      results: Array<{ state: string; status: string; message: string }>;
    };

    expect(body.success).toBe(true);
    expect(body.summary.degraded).toBe(1);
    expect(body.summary.healthy).toBe(0);
    expect(body.summary.failed).toBe(0);
    expect(body.results[0]).toMatchObject({
      state: 'degraded',
      status: 'success',
      message: '站点不支持签到接口',
    });
  });
});
