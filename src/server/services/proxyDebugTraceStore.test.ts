import { afterEach, describe, expect, it } from 'vitest';
import { Response } from 'undici';
import { config } from '../config.js';
import {
  appendProxyDebugTrace,
  clearProxyDebugTraces,
  flushProxyDebugTracePersistence,
  listProxyDebugTraces,
  summarizeProxyDebugTraces,
} from './proxyDebugTraceStore.js';

describe('proxyDebugTraceStore', () => {
  const originalEnabled = config.proxyDebugTraceEnabled;
  const originalMaxEntries = config.proxyDebugTraceMaxEntries;

  afterEach(() => {
    config.proxyDebugTraceEnabled = originalEnabled;
    config.proxyDebugTraceMaxEntries = originalMaxEntries;
    clearProxyDebugTraces();
  });

  it('lists traces up to the configured retention ceiling', async () => {
    config.proxyDebugTraceEnabled = true;
    config.proxyDebugTraceMaxEntries = 800;

    for (let i = 0; i < 820; i += 1) {
      appendProxyDebugTrace({
        kind: 'channel_selected',
        traceId: 'session:test-trace',
        sessionId: 'test-trace',
        traceHint: null,
        requestedModel: 'gpt-4o',
        retryCount: i,
      });
    }

    const items = await listProxyDebugTraces({
      sessionId: 'test-trace',
      limit: 9999,
    });

    expect(items).toHaveLength(800);
    expect(items[0]?.retryCount).toBe(20);
    expect(items[items.length - 1]?.retryCount).toBe(819);
  });

  it('normalizes undici headers nested inside detail payloads', async () => {
    config.proxyDebugTraceEnabled = true;

    const response = new Response('ok', {
      headers: {
        'content-type': 'application/json',
        'x-trace-id': 'trace-123',
      },
    });

    appendProxyDebugTrace({
      kind: 'endpoint_final_failure',
      traceId: 'session:trace-with-headers',
      sessionId: 'trace-with-headers',
      traceHint: null,
      requestedModel: 'gpt-4o',
      detail: {
        responseHeaders: response.headers,
      },
    });

    const [item] = await listProxyDebugTraces({ sessionId: 'trace-with-headers', limit: 5 });
    expect(item?.detail).toEqual({
      responseHeaders: {
        'content-type': 'application/json',
        'x-trace-id': 'trace-123',
      },
    });
  });

  it('persists traces and builds summary buckets', async () => {
    config.proxyDebugTraceEnabled = true;

    appendProxyDebugTrace({
      kind: 'proxy_success',
      traceId: 'session:site-a',
      sessionId: 'site-a',
      traceHint: null,
      requestedModel: 'gpt-4o',
      siteId: 11,
      siteName: 'Alpha',
    });
    appendProxyDebugTrace({
      kind: 'proxy_exception',
      traceId: 'session:site-a',
      sessionId: 'site-a',
      traceHint: null,
      requestedModel: 'gpt-4o',
      siteId: 11,
      siteName: 'Alpha',
    });
    appendProxyDebugTrace({
      kind: 'proxy_success',
      traceId: 'session:site-b',
      sessionId: 'site-b',
      traceHint: null,
      requestedModel: 'claude-sonnet-4.5',
      siteId: 22,
      siteName: 'Beta',
    });

    await flushProxyDebugTracePersistence();

    const summary = await summarizeProxyDebugTraces();
    expect(summary.total).toBeGreaterThanOrEqual(3);
    expect(summary.kinds.proxy_success).toBeGreaterThanOrEqual(2);
    expect(summary.sites[0]).toMatchObject({
      siteId: 11,
      siteName: 'Alpha',
      count: 2,
    });
  });
});
