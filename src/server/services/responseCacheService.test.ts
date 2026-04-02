import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  hasResponseCacheTableMock,
  dbSelectMock,
  dbSelectGetMock,
  dbSelectAllMock,
  dbUpdateMock,
  dbUpdateSetMock,
  dbUpdateWhereMock,
  dbUpdateRunMock,
  dbInsertMock,
  dbInsertValuesMock,
  dbInsertRunMock,
  dbInsertConflictRunMock,
  dbDeleteMock,
  dbDeleteWhereMock,
  dbDeleteRunMock,
  responseCacheSchema,
} = vi.hoisted(() => ({
  hasResponseCacheTableMock: vi.fn(),
  dbSelectMock: vi.fn(),
  dbSelectGetMock: vi.fn(),
  dbSelectAllMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  dbUpdateSetMock: vi.fn(),
  dbUpdateWhereMock: vi.fn(),
  dbUpdateRunMock: vi.fn(),
  dbInsertMock: vi.fn(),
  dbInsertValuesMock: vi.fn(),
  dbInsertRunMock: vi.fn(),
  dbInsertConflictRunMock: vi.fn(),
  dbDeleteMock: vi.fn(),
  dbDeleteWhereMock: vi.fn(),
  dbDeleteRunMock: vi.fn(),
  responseCacheSchema: {
    id: 'id',
    cacheKey: 'cache_key',
    model: 'model',
    responseBody: 'response_body',
    isStream: 'is_stream',
    promptTokens: 'prompt_tokens',
    completionTokens: 'completion_tokens',
    estimatedCost: 'estimated_cost',
    hitCount: 'hit_count',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
  },
}));

vi.mock('../config.js', () => ({
  config: {
    responseCacheStaleIfErrorMs: 600_000,
    responseCacheTtlMs: 3_600_000,
    responseCacheMaxRows: 2_000,
    responseCacheInflightTtlMs: 30_000,
  },
}));

vi.mock('../db/index.js', () => ({
  runtimeDbDialect: 'sqlite',
  hasResponseCacheTable: (...args: unknown[]) => hasResponseCacheTableMock(...args),
  db: {
    select: (...args: unknown[]) => dbSelectMock(...args),
    update: (...args: unknown[]) => dbUpdateMock(...args),
    insert: (...args: unknown[]) => dbInsertMock(...args),
    delete: (...args: unknown[]) => dbDeleteMock(...args),
  },
  schema: {
    responseCache: responseCacheSchema,
  },
}));

import {
  __responseCacheServiceTestUtils,
  buildCacheKey,
  getInflightResponseCacheWrite,
  isResponseCacheAvailable,
  lookupResponseCache,
  lookupStaleResponseCache,
  registerInflightResponseCacheWrite,
  reserveInflightResponseCacheWrite,
  resetResponseCacheAvailabilityForTests,
  writeResponseCache,
} from './responseCacheService.js';

describe('responseCacheService', () => {
  beforeEach(() => {
    resetResponseCacheAvailabilityForTests();
    hasResponseCacheTableMock.mockReset();
    dbSelectMock.mockReset();
    dbSelectGetMock.mockReset();
    dbSelectAllMock.mockReset();
    dbUpdateMock.mockReset();
    dbUpdateSetMock.mockReset();
    dbUpdateWhereMock.mockReset();
    dbUpdateRunMock.mockReset();
    dbInsertMock.mockReset();
    dbInsertValuesMock.mockReset();
    dbInsertRunMock.mockReset();
    dbInsertConflictRunMock.mockReset();
    dbDeleteMock.mockReset();
    dbDeleteWhereMock.mockReset();
    dbDeleteRunMock.mockReset();

    hasResponseCacheTableMock.mockResolvedValue(true);

    const selectChain = {
      from: () => selectChain,
      where: () => selectChain,
      orderBy: () => selectChain,
      get: () => dbSelectGetMock(),
      all: () => dbSelectAllMock(),
    };
    dbSelectMock.mockReturnValue(selectChain);

    const updateChain = {
      set: (...args: unknown[]) => dbUpdateSetMock(...args),
    };
    dbUpdateMock.mockReturnValue(updateChain);
    dbUpdateSetMock.mockReturnValue({
      where: (...args: unknown[]) => dbUpdateWhereMock(...args),
    });
    dbUpdateWhereMock.mockReturnValue({
      run: (...args: unknown[]) => dbUpdateRunMock(...args),
    });
    dbUpdateRunMock.mockResolvedValue(undefined);

    dbInsertMock.mockReturnValue({
      values: (...args: unknown[]) => dbInsertValuesMock(...args),
    });
    dbInsertValuesMock.mockReturnValue({
      onConflictDoUpdate: () => ({
        run: (...args: unknown[]) => dbInsertConflictRunMock(...args),
      }),
      run: (...args: unknown[]) => dbInsertRunMock(...args),
    });
    dbInsertRunMock.mockResolvedValue(undefined);
    dbInsertConflictRunMock.mockResolvedValue(undefined);

    dbDeleteMock.mockReturnValue({
      where: (...args: unknown[]) => dbDeleteWhereMock(...args),
    });
    dbDeleteWhereMock.mockReturnValue({
      run: (...args: unknown[]) => dbDeleteRunMock(...args),
    });
    dbDeleteRunMock.mockResolvedValue(undefined);
  });

  it('builds stable cache keys for equivalent payload shapes and isolates route scope', () => {
    const base = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup', type: 'function' }],
      tool_choice: { type: 'function', name: 'lookup' },
      response_format: { type: 'json_schema', schema: { b: 2, a: 1 } },
      routeScope: 'route:1|site:2|actual:gpt-5',
    };

    const first = buildCacheKey(base);
    const second = buildCacheKey({
      model: 'gpt-5',
      messages: [{ content: 'hi', role: 'user' }],
      tools: [{ type: 'function', name: 'lookup' }],
      tool_choice: { name: 'lookup', type: 'function' },
      response_format: { schema: { a: 1, b: 2 }, type: 'json_schema' },
      routeScope: 'route:1|site:2|actual:gpt-5',
    });
    const differentScope = buildCacheKey({
      ...base,
      routeScope: 'route:9|site:2|actual:gpt-5',
    });

    expect(first).toHaveLength(64);
    expect(second).toBe(first);
    expect(differentScope).not.toBe(first);
  });

  it('returns null cache key for non-deterministic temperature requests', () => {
    expect(buildCacheKey({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.1,
    })).toBeNull();
  });

  it('returns null cache key for non-deterministic top_p requests', () => {
    expect(buildCacheKey({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      top_p: 0.9,
    })).toBeNull();
  });

  it('formats route scope from selected route metadata', () => {
    expect(__responseCacheServiceTestUtils.buildRouteScope({
      routeId: 7,
      siteId: 9,
      actualModel: 'gpt-4.1-mini',
    })).toBe('route:7|site:9|actual:gpt-4.1-mini');
    expect(__responseCacheServiceTestUtils.buildRouteScope({})).toBeNull();
  });

  it('caches availability probe results and can reset them', async () => {
    hasResponseCacheTableMock.mockResolvedValueOnce(true);

    await expect(isResponseCacheAvailable()).resolves.toBe(true);
    await expect(isResponseCacheAvailable()).resolves.toBe(true);
    expect(hasResponseCacheTableMock).toHaveBeenCalledTimes(1);

    resetResponseCacheAvailabilityForTests();
    hasResponseCacheTableMock.mockResolvedValueOnce(false);
    await expect(isResponseCacheAvailable()).resolves.toBe(false);
    expect(hasResponseCacheTableMock).toHaveBeenCalledTimes(2);
  });

  it('returns fresh cache rows and bumps hit count asynchronously', async () => {
    dbSelectGetMock.mockResolvedValue({
      responseBody: JSON.stringify({ ok: true }),
      isStream: false,
      promptTokens: 11,
      completionTokens: 7,
      estimatedCost: 1.23456789,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });

    await expect(lookupResponseCache('cache-key')).resolves.toEqual({
      body: JSON.stringify({ ok: true }),
      isStream: false,
      promptTokens: 11,
      completionTokens: 7,
      estimatedCost: 1.234568,
    });
    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
    expect(dbDeleteMock).not.toHaveBeenCalled();
  });

  it('drops expired rows on lookup and treats them as misses', async () => {
    dbSelectGetMock.mockResolvedValue({
      responseBody: JSON.stringify({ stale: true }),
      isStream: false,
      promptTokens: 1,
      completionTokens: 2,
      estimatedCost: 0.5,
      expiresAt: new Date(Date.now() - 30_000).toISOString(),
    });

    await expect(lookupResponseCache('expired-key')).resolves.toBeNull();
    expect(dbDeleteMock).toHaveBeenCalledTimes(1);
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('serves stale cache within allowed staleness window', async () => {
    dbSelectGetMock.mockResolvedValue({
      responseBody: JSON.stringify({ fallback: true }),
      isStream: false,
      promptTokens: 2,
      completionTokens: 3,
      estimatedCost: 0.7654321,
      expiresAt: new Date(Date.now() - 5_000).toISOString(),
    });

    await expect(lookupStaleResponseCache('stale-key', 60_000)).resolves.toEqual({
      body: JSON.stringify({ fallback: true }),
      isStream: false,
      promptTokens: 2,
      completionTokens: 3,
      estimatedCost: 0.765432,
    });
  });

  it('tracks inflight cache write registrations and joins', async () => {
    let resolveWrite: ((value: { body: string; isStream: false; promptTokens: number; completionTokens: number; estimatedCost: number }) => void) | null = null;
    const task = new Promise<{ body: string; isStream: false; promptTokens: number; completionTokens: number; estimatedCost: number }>((resolve) => {
      resolveWrite = resolve;
    });

    const registered = registerInflightResponseCacheWrite('cache-key', task);
    const joined = getInflightResponseCacheWrite('cache-key');

    expect(joined).toBeTruthy();
    resolveWrite?.({
      body: JSON.stringify({ ok: true }),
      isStream: false,
      promptTokens: 2,
      completionTokens: 1,
      estimatedCost: 0.12,
    });

    await expect(registered).resolves.toEqual({
      response: {
        body: JSON.stringify({ ok: true }),
        isStream: false,
        promptTokens: 2,
        completionTokens: 1,
        estimatedCost: 0.12,
      },
      cacheStatus: 'hit',
    });
    await expect(joined).resolves.toEqual({
      response: {
        body: JSON.stringify({ ok: true }),
        isStream: false,
        promptTokens: 2,
        completionTokens: 1,
        estimatedCost: 0.12,
      },
      cacheStatus: 'hit',
    });
    expect(getInflightResponseCacheWrite('cache-key')).toBeNull();
  });

  it('can reserve inflight cache coordination before the cache write starts', async () => {
    const reserved = reserveInflightResponseCacheWrite('pending-key');
    const joined = getInflightResponseCacheWrite('pending-key');

    expect(joined).toBeTruthy();
    reserved.resolve({
      response: {
        body: JSON.stringify({ queued: true }),
        isStream: false,
        promptTokens: 4,
        completionTokens: 2,
        estimatedCost: 0.34,
      },
      cacheStatus: 'hit',
    });

    await expect(joined).resolves.toEqual({
      response: {
        body: JSON.stringify({ queued: true }),
        isStream: false,
        promptTokens: 4,
        completionTokens: 2,
        estimatedCost: 0.34,
      },
      cacheStatus: 'hit',
    });
    await expect(reserved.promise).resolves.toEqual({
      response: {
        body: JSON.stringify({ queued: true }),
        isStream: false,
        promptTokens: 4,
        completionTokens: 2,
        estimatedCost: 0.34,
      },
      cacheStatus: 'hit',
    });
    expect(getInflightResponseCacheWrite('pending-key')).toBeNull();
  });

  it('marks cache unavailable after write failures to avoid repeated silent errors', async () => {
    dbInsertConflictRunMock.mockRejectedValueOnce(new Error('write failed'));

    await expect(writeResponseCache('cache-key', 'gpt-5', {
      body: JSON.stringify({ ok: true }),
      isStream: false,
      promptTokens: 1,
      completionTokens: 2,
      estimatedCost: 3.456789,
    })).resolves.toBeUndefined();

    expect(dbInsertMock).toHaveBeenCalledTimes(1);

    await expect(isResponseCacheAvailable()).resolves.toBe(false);
    expect(hasResponseCacheTableMock).toHaveBeenCalledTimes(1);
  });

  it('re-probes cache availability after cooldown following transient failures', async () => {
    vi.useFakeTimers();
    try {
      dbInsertConflictRunMock.mockRejectedValueOnce(new Error('write failed'));

      await expect(writeResponseCache('cache-key', 'gpt-5', {
        body: JSON.stringify({ ok: true }),
        isStream: false,
        promptTokens: 1,
        completionTokens: 2,
        estimatedCost: 3.456789,
      })).resolves.toBeUndefined();

      await expect(isResponseCacheAvailable()).resolves.toBe(false);
      expect(hasResponseCacheTableMock).toHaveBeenCalledTimes(1);

      hasResponseCacheTableMock.mockResolvedValueOnce(true);
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(isResponseCacheAvailable()).resolves.toBe(true);
      expect(hasResponseCacheTableMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
