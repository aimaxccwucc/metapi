import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

describe('optimization routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-optimization-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./optimization.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.optimizationRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.modelCapabilityProfiles).run();
    await db.delete(schema.siteProtocolProfiles).run();
    await db.delete(schema.siteProfiles).run();
    await db.delete(schema.checkinStates).run();
    await db.delete(schema.routingGovernanceStates).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('builds a unified optimization overview and backfills profiles', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ops-site',
      url: 'https://ops.example.com',
      platform: 'new-api',
      status: 'active',
      healthStatus: 'alive',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'ops-user',
      accessToken: 'session-token',
      status: 'active',
      checkinEnabled: true,
      extraConfig: JSON.stringify({
        checkinSnapshot: {
          version: 1,
          status: 'manual_required',
          reasonCode: 'manual_turnstile_required',
          retryable: false,
          requiresManual: true,
          unsupported: false,
          lastAttemptAt: '2026-04-27T00:00:00.000Z',
          message: '需要人工验证',
          source: 'checkin',
        },
      }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.4',
      available: true,
      latencyMs: 120,
    }).run();

    const response = await app.inject({ method: 'GET', url: '/api/optimization/overview' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as any;
    expect(body.success).toBe(true);
    expect(body.counts.sites).toBe(1);
    expect(body.counts.accounts).toBe(1);
    expect(body.counts.siteProfiles).toBe(1);
    expect(body.counts.checkinStates).toBe(1);
    expect(body.counts.checkinAttention).toBe(1);
    expect(body.counts.modelCapabilities).toBe(1);
    expect(body.optimizationItems).toHaveLength(16);
    expect(body.topSites[0]).toMatchObject({
      siteId: site.id,
      name: 'ops-site',
      accountCount: 1,
    });
  });

  it('persists operational policy changes', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/optimization/policies',
      payload: {
        responseCache: { enabled: true, ttlMs: 120000 },
        retryBudget: { maxRetries: 2, maxChannelAttempts: 2 },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      policies: {
        responseCache: { enabled: true, ttlMs: 120000 },
        retryBudget: { maxRetries: 2, maxChannelAttempts: 2 },
      },
    });

    const readBack = await app.inject({ method: 'GET', url: '/api/optimization/policies' });
    expect(readBack.json()).toMatchObject({
      policies: {
        responseCache: { enabled: true, ttlMs: 120000 },
        retryBudget: { maxRetries: 2, maxChannelAttempts: 2 },
      },
    });
  });

  it('sanitizes invalid operational policy input', async () => {
    const initial = (await app.inject({ method: 'GET', url: '/api/optimization/policies' })).json() as any;

    const response = await app.inject({
      method: 'PUT',
      url: '/api/optimization/policies',
      payload: {
        responseCache: { ttlMs: 'bad', maxRows: 50, staleIfErrorMs: null },
        retryBudget: { requestBudgetMs: 'bad', maxRetries: 99, maxChannelAttempts: 0 },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any;
    expect(body.policies.responseCache.ttlMs).toBe(initial.policies.responseCache.ttlMs);
    expect(body.policies.responseCache.maxRows).toBe(100);
    expect(body.policies.responseCache.staleIfErrorMs).toBe(1000);
    expect(body.policies.retryBudget.requestBudgetMs).toBe(initial.policies.retryBudget.requestBudgetMs);
    expect(body.policies.retryBudget.maxRetries).toBe(8);
    expect(body.policies.retryBudget.maxChannelAttempts).toBe(1);
  });

  it('returns copyable diagnostic text', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/optimization/diagnostics-text' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { success: boolean; text: string };
    expect(body.success).toBe(true);
    expect(body.text).toContain('Metapi 优化诊断');
    expect(body.text).toContain('16项状态');
  });
});
