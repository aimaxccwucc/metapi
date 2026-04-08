import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendProxyDebugTrace, clearProxyDebugTraces } from '../../services/proxyDebugTraceStore.js';

describe('stats proxy debug traces api', () => {
  let app: FastifyInstance;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-stats-proxy-debug-traces-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const routesModule = await import('./stats.js');

    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(() => {
    clearProxyDebugTraces();
  });

  afterAll(async () => {
    clearProxyDebugTraces();
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('filters debug traces by session id and respects limit', async () => {
    appendProxyDebugTrace({
      kind: 'route_selected',
      traceId: 'session:turn-1',
      sessionId: 'turn-1',
      traceHint: null,
      requestedModel: 'gpt-5.2',
      retryCount: 0,
      detail: { phase: 'select' },
    });
    appendProxyDebugTrace({
      kind: 'proxy_retry',
      traceId: 'session:turn-1',
      sessionId: 'turn-1',
      traceHint: null,
      requestedModel: 'gpt-5.2',
      retryCount: 1,
      detail: { phase: 'retry' },
    });
    appendProxyDebugTrace({
      kind: 'route_selected',
      traceId: 'trace:req-2',
      sessionId: null,
      traceHint: 'req-2',
      requestedModel: 'claude-sonnet-4.5',
      retryCount: 0,
      detail: { phase: 'other' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/proxy-debug-traces?sessionId=turn-1&limit=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      total: number;
      summary?: { total?: number; kinds?: Record<string, number> };
      items: Array<Record<string, unknown>>;
    };

    expect(body.success).toBe(true);
    expect(body.total).toBe(1);
    expect(body.summary?.total).toBeGreaterThanOrEqual(3);
    expect(body.summary?.kinds?.route_selected).toBeGreaterThanOrEqual(2);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      kind: 'proxy_retry',
      sessionId: 'turn-1',
      traceId: 'session:turn-1',
      retryCount: 1,
    });
  });

  it('filters debug traces by kind and site id', async () => {
    appendProxyDebugTrace({
      kind: 'proxy_success',
      traceId: 'session:alpha',
      sessionId: 'alpha',
      traceHint: null,
      requestedModel: 'gpt-4o',
      siteId: 1,
      siteName: 'Alpha',
    });
    appendProxyDebugTrace({
      kind: 'proxy_exception',
      traceId: 'session:alpha',
      sessionId: 'alpha',
      traceHint: null,
      requestedModel: 'gpt-4o',
      siteId: 1,
      siteName: 'Alpha',
    });
    appendProxyDebugTrace({
      kind: 'proxy_success',
      traceId: 'session:beta',
      sessionId: 'beta',
      traceHint: null,
      requestedModel: 'gpt-4o-mini',
      siteId: 2,
      siteName: 'Beta',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/proxy-debug-traces?kind=proxy_success&siteId=1&limit=10',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      total: number;
      items: Array<Record<string, unknown>>;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      kind: 'proxy_success',
      siteId: 1,
      siteName: 'Alpha',
    });
  });
});
