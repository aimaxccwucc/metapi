import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn();
const resolveProxyLogBillingMock = vi.fn();
const insertProxyLogMock = vi.fn(async () => undefined);

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
  refreshModelsAndRebuildRoutesOnDemand: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
  reportProxyAllFailedBestEffort: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpiredBestEffort: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: ({ status }: { status?: number }) => status === 401 || status === 403,
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: (status: number) => status === 401 || status === 403 || status >= 500,
  shouldAvoidSiteForRequest: () => false,
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (...args: unknown[]) => resolveProxyUsageWithSelfLogFallbackMock(...args),
}));

vi.mock('./proxyBilling.js', () => ({
  resolveProxyLogBilling: (...args: unknown[]) => resolveProxyLogBillingMock(...args),
}));

vi.mock('../../services/proxyLogStore.js', () => ({
  insertProxyLog: (...args: unknown[]) => insertProxyLogMock(...args),
  insertProxyLogBestEffort: (...args: unknown[]) => insertProxyLogMock(...args),
  resolveProxyLogRouteContext: (selected: any) => ({
    routeId: selected?.channel?.routeId ?? null,
    entryRouteId: selected?.entryRouteId ?? selected?.channel?.routeId ?? null,
    sourceRouteId: selected?.sourceRouteId ?? selected?.channel?.routeId ?? null,
  }),
}));

describe('/v1/embeddings route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { embeddingsProxyRoute } = await import('./embeddings.js');
    app = Fastify();
    await app.register(embeddingsProxyRoute);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockReset();
    resolveProxyLogBillingMock.mockReset();
    insertProxyLogMock.mockReset();

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'text-embedding-3-large',
    });
    selectNextChannelMock.mockReturnValue(null);
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValue({
      promptTokens: 12,
      completionTokens: 0,
      totalTokens: 12,
    });
    resolveProxyLogBillingMock.mockResolvedValue({
      estimatedCost: 0.12,
      billingDetails: null,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('forwards embeddings requests to upstream and records success cost', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: 'list',
      data: [{ embedding: [0.1, 0.2], index: 0 }],
      usage: {
        prompt_tokens: 12,
        total_tokens: 12,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: {
        model: 'text-embedding-3-large',
        input: 'hello embeddings',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(selectChannelMock).toHaveBeenCalledWith('text-embedding-3-large', expect.anything());
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://upstream.example.com/v1/embeddings');
    expect(JSON.parse(String(requestInit.body))).toEqual({
      model: 'text-embedding-3-large',
      input: 'hello embeddings',
    });
    expect(recordSuccessMock).toHaveBeenCalledWith(11, expect.any(Number), 0.12, 'text-embedding-3-large');
  });

  it('fails over to the next channel after auth failure', async () => {
    selectChannelMock.mockReturnValueOnce({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'bad-site', url: 'https://bad.example.com', platform: 'openai' },
      account: { id: 33, username: 'bad-user' },
      tokenName: 'default',
      tokenValue: 'sk-bad',
      actualModel: 'text-embedding-3-large',
    });
    selectNextChannelMock.mockReturnValueOnce({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'good-site', url: 'https://good.example.com', platform: 'openai' },
      account: { id: 34, username: 'good-user' },
      tokenName: 'default',
      tokenValue: 'sk-good',
      actualModel: 'text-embedding-3-large',
    });
    fetchMock
      .mockResolvedValueOnce(new Response('invalid api key', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: 'list',
        data: [{ embedding: [0.3, 0.4], index: 0 }],
        usage: {
          prompt_tokens: 8,
          total_tokens: 8,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    resolveProxyUsageWithSelfLogFallbackMock.mockResolvedValueOnce({
      promptTokens: 8,
      completionTokens: 0,
      totalTokens: 8,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: {
        model: 'text-embedding-3-large',
        input: 'retry me',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 401,
      errorText: 'invalid api key',
      modelName: 'text-embedding-3-large',
    }));
    expect(reportTokenExpiredMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 33,
      siteName: 'bad-site',
    }));
    expect(selectNextChannelMock).toHaveBeenCalledTimes(1);
    expect(selectNextChannelMock.mock.calls[0]?.[0]).toBe('text-embedding-3-large');
    expect(selectNextChannelMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([11]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://good.example.com/v1/embeddings');
  });

  it('returns server_error when no embeddings channel is available', async () => {
    selectChannelMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    refreshModelsAndRebuildRoutesMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: {
        model: 'text-embedding-3-large',
        input: 'no route',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        message: 'No available channels',
        type: 'server_error',
      },
    });
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'text-embedding-3-large',
      reason: 'No available channels after retries',
    }));
  });
});
