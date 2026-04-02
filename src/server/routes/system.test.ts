import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type SystemRoutesModule = typeof import('./system.js');

const listBackgroundTasksMock = vi.fn();
const getOAuthLoopbackCallbackServerStatesMock = vi.fn();
const getRetryBackoffMetricsMock = vi.fn();
const getOnDemandRefreshMetricsMock = vi.fn();

vi.mock('../services/backgroundTaskService.js', () => ({
  listBackgroundTasks: (...args: unknown[]) => listBackgroundTasksMock(...args),
}));

vi.mock('../services/oauth/localCallbackServer.js', () => ({
  getOAuthLoopbackCallbackServerStates: (...args: unknown[]) => getOAuthLoopbackCallbackServerStatesMock(...args),
}));

vi.mock('./proxy/requestBudget.js', async () => {
  const actual = await vi.importActual<typeof import('./proxy/requestBudget.js')>('./proxy/requestBudget.js');
  return {
    ...actual,
    getRetryBackoffMetrics: (...args: unknown[]) => getRetryBackoffMetricsMock(...args),
  };
});

vi.mock('../services/modelService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/modelService.js')>('../services/modelService.js');
  return {
    ...actual,
    getOnDemandRefreshMetrics: (...args: unknown[]) => getOnDemandRefreshMetricsMock(...args),
  };
});

describe('system routes', () => {
  let systemRoutes: SystemRoutesModule['systemRoutes'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-system-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const systemRoutesModule = await import('./system.js');
    systemRoutes = systemRoutesModule.systemRoutes;
  });

  afterEach(() => {
    listBackgroundTasksMock.mockReset();
    getOAuthLoopbackCallbackServerStatesMock.mockReset();
    getRetryBackoffMetricsMock.mockReset();
    getOnDemandRefreshMetricsMock.mockReset();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('exposes public health and readiness endpoints', async () => {
    listBackgroundTasksMock.mockReturnValue([
      {
        id: 'task-1',
        status: 'running',
      },
      {
        id: 'task-2',
        status: 'failed',
      },
    ]);
    getOAuthLoopbackCallbackServerStatesMock.mockReturnValue([
      {
        provider: 'codex',
        attempted: true,
        ready: true,
        port: 1455,
        path: '/callback',
        origin: 'http://localhost:1455',
        redirectUri: 'http://localhost:1455/callback',
      },
    ]);
    getRetryBackoffMetricsMock.mockReturnValue({
      totalMs: 1200,
      count: 3,
    });
    getOnDemandRefreshMetricsMock.mockReturnValue({
      triggeredTotal: 2,
      skippedTotal: 5,
    });

    const app = Fastify();
    await app.register(systemRoutes, {
      startedAt: new Date(Date.now() - 15_000),
    });

    const healthz = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);
    expect(healthz.json()).toMatchObject({
      ok: true,
      service: 'metapi',
    });

    const readyz = await app.inject({ method: 'GET', url: '/readyz' });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json()).toMatchObject({
      ok: true,
      database: {
        ready: true,
      },
      responseCache: {
        ready: true,
        availabilityChecked: true,
      },
      downstreamAuthCache: {
        size: expect.any(Number),
        inflight: expect.any(Number),
      },
      oauthLoopback: {
        ready: 1,
        total: 1,
      },
      backgroundTasks: {
        total: 2,
        running: 1,
        failed: 1,
      },
    });

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain('metapi_up 1');
    expect(metrics.body).toContain('metapi_ready 1');
    expect(metrics.body).toContain('metapi_response_cache_ready 1');
    expect(metrics.body).toContain('metapi_response_cache_failures_total{kind="write"} 0');
    expect(metrics.body).toContain('metapi_response_cache_inflight_total{kind="registered"}');
    expect(metrics.body).toContain('metapi_downstream_auth_cache_total{kind="hit"}');
    expect(metrics.body).toContain('metapi_downstream_auth_cache_entries{kind="cached"}');
    expect(metrics.body).toContain('metapi_retry_backoff_ms_total 1200');
    expect(metrics.body).toContain('metapi_refresh_triggered_total 2');
    expect(metrics.body).toContain('metapi_on_demand_refresh_skipped_total 5');

    await app.close();
  });

  it('exposes protected runtime overview summary', async () => {
    listBackgroundTasksMock.mockReturnValue([]);
    getOAuthLoopbackCallbackServerStatesMock.mockReturnValue([]);
    getRetryBackoffMetricsMock.mockReturnValue({
      totalMs: 0,
      count: 0,
    });
    getOnDemandRefreshMetricsMock.mockReturnValue({
      triggeredTotal: 0,
      skippedTotal: 0,
    });

    const app = Fastify();
    await app.register(systemRoutes, {
      startedAt: new Date(Date.now() - 5_000),
    });

    const response = await app.inject({ method: 'GET', url: '/api/system/runtime-overview' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: {
        name: 'metapi',
      },
      database: {
        ready: true,
      },
      responseCache: {
        ready: true,
        availabilityChecked: true,
      },
      downstreamAuthCache: {
        size: expect.any(Number),
        inflight: expect.any(Number),
      },
      gatewayRouting: {
        retryBackoffMs: 0,
        retryBackoffCount: 0,
        onDemandRefreshTriggeredTotal: 0,
        onDemandRefreshSkippedTotal: 0,
      },
      backgroundTasks: {
        total: 0,
      },
      recentActivity: {
        proxyRequests24h: expect.any(Number),
        unreadEvents: expect.any(Number),
      },
    });

    await app.close();
  });
});
