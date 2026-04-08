import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatUtcSqlDateTime, getLocalDayRangeUtc, parseStoredUtcDateTime } from '../../services/localTimeService.js';

vi.mock('../../services/checkinService.js', () => ({
  checkinAll: vi.fn(),
  checkinAccount: vi.fn(),
}));

vi.mock('../../services/checkinScheduler.js', () => ({
  updateCheckinSchedule: vi.fn(),
}));

type DbModule = typeof import('../../db/index.js');

describe('GET /api/checkin/logs date filter', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-checkin-logs-date-filter-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./checkin.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.checkinRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns only current local-day logs when no range is provided', async () => {
    const { startUtc, endUtc } = getLocalDayRangeUtc();
    const startDate = parseStoredUtcDateTime(startUtc)!;
    const endDate = parseStoredUtcDateTime(endUtc)!;
    const beforeStart = formatUtcSqlDateTime(new Date(startDate.getTime() - 60_000));
    const inRange = formatUtcSqlDateTime(new Date(startDate.getTime() + 60_000));
    const afterEnd = formatUtcSqlDateTime(new Date(endDate.getTime() + 60_000));

    const site = await db.insert(schema.sites).values({
      name: 'checkin-log-site',
      url: 'https://checkin-log-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'checkin-log-user',
      accessToken: 'token',
      status: 'active',
    }).returning().get();

    await db.insert(schema.checkinLogs).values([
      {
        accountId: account.id,
        status: 'success',
        message: 'before-start',
        reward: '0',
        createdAt: beforeStart,
      },
      {
        accountId: account.id,
        status: 'success',
        message: 'in-range',
        reward: '1',
        createdAt: inRange,
      },
      {
        accountId: account.id,
        status: 'success',
        message: 'after-end',
        reward: '2',
        createdAt: afterEnd,
      },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/checkin/logs',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ checkin_logs: { message: string } }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.checkin_logs.message).toBe('in-range');
  });

  it('returns logs for the requested custom range', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'history-checkin-site',
      url: 'https://history-checkin-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'history-checkin-user',
      accessToken: 'token',
      status: 'active',
    }).returning().get();

    await db.insert(schema.checkinLogs).values([
      {
        accountId: account.id,
        status: 'success',
        message: 'history-hit',
        reward: '1',
        createdAt: '2026-03-08 10:00:00',
      },
      {
        accountId: account.id,
        status: 'success',
        message: 'history-miss',
        reward: '2',
        createdAt: '2026-03-09 10:00:00',
      },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/checkin/logs?from=2026-03-08T00:00&to=2026-03-08T23:59',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ checkin_logs: { message: string } }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.checkin_logs.message).toBe('history-hit');
  });
});
