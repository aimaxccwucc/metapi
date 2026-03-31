import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  appendProxyDebugTrace,
  clearProxyDebugTraces,
  listProxyDebugTraces,
} from './proxyDebugTraceStore.js';

describe('proxyDebugTraceStore', () => {
  const originalEnabled = config.proxyDebugTraceEnabled;
  const originalMaxEntries = config.proxyDebugTraceMaxEntries;

  afterEach(() => {
    config.proxyDebugTraceEnabled = originalEnabled;
    config.proxyDebugTraceMaxEntries = originalMaxEntries;
    clearProxyDebugTraces();
  });

  it('lists traces up to the configured retention ceiling', () => {
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

    const items = listProxyDebugTraces({
      sessionId: 'test-trace',
      limit: 9999,
    });

    expect(items).toHaveLength(800);
    expect(items[0]?.retryCount).toBe(20);
    expect(items[items.length - 1]?.retryCount).toBe(819);
  });
});
