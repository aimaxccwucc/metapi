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
const estimateProxyCostMock = vi.fn(async () => 0);
const dbInsertMock = vi.fn((_arg?: any) => ({
  values: () => ({
    run: () => undefined,
  }),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

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
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: ({ status }: { status?: number }) => status === 401 || status === 403,
}));

vi.mock('../../services/modelPricingService.js', () => ({
  estimateProxyCost: (arg?: any) => (estimateProxyCostMock as any)(arg),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: (status: number) => status === 401 || status === 403 || status >= 500,
  shouldAvoidSiteForRequest: () => false,
}));

vi.mock('../../db/index.js', () => ({
  db: {
    insert: (arg: any) => dbInsertMock(arg),
  },
  hasProxyLogBillingDetailsColumn: async () => false,
  hasProxyLogClientColumns: async () => false,
  hasProxyLogDownstreamApiKeyIdColumn: async () => false,
  schema: {
    proxyLogs: {},
  },
}));

describe('/v1/search route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { searchProxyRoute } = await import('./search.js');
    app = Fastify();
    await app.register(searchProxyRoute);
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
    estimateProxyCostMock.mockClear();
    dbInsertMock.mockClear();

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: '__search',
    });
    selectNextChannelMock.mockReturnValue(null);
  });

  afterAll(async () => {
    await app.close();
  });

  it('defaults model to __search and forwards to the upstream /v1/search endpoint', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: 'search.result',
      data: [{ title: 'AxonHub' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        query: 'axonhub',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(selectChannelMock).toHaveBeenCalledWith('__search', expect.anything());
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://upstream.example.com/v1/search');
    expect(JSON.parse(String(requestInit.body))).toEqual({
      query: 'axonhub',
      max_results: 10,
      model: '__search',
    });
  });

  it('rejects max_results outside the allowed range', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        query: 'axonhub',
        max_results: 21,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: 'max_results must be an integer between 1 and 20',
        type: 'invalid_request_error',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects max_results below the allowed range', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        query: 'axonhub',
        max_results: 0,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: 'max_results must be an integer between 1 and 20',
        type: 'invalid_request_error',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects streaming search requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        query: 'axonhub',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: 'search does not support streaming',
        type: 'invalid_request_error',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('switches to the next channel after auth failure on the first source', async () => {
    selectChannelMock.mockReturnValueOnce({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'bad-site', url: 'https://bad.example.com', platform: 'openai' },
      account: { id: 33, username: 'bad-user' },
      tokenName: 'default',
      tokenValue: 'sk-bad',
      actualModel: '__search',
    });
    selectNextChannelMock.mockReturnValueOnce({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'good-site', url: 'https://good.example.com', platform: 'openai' },
      account: { id: 34, username: 'good-user' },
      tokenName: 'default',
      tokenValue: 'sk-good',
      actualModel: '__search',
    });
    fetchMock
      .mockResolvedValueOnce(new Response('invalid api key', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: 'search.result', data: [{ title: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        query: 'axonhub',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 401,
      errorText: 'invalid api key',
      modelName: '__search',
    }));
    expect(reportTokenExpiredMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 33,
      siteName: 'bad-site',
    }));
    expect(selectNextChannelMock).toHaveBeenCalledTimes(1);
    expect(selectNextChannelMock.mock.calls[0]?.[0]).toBe('__search');
    expect(selectNextChannelMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([11]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://good.example.com/v1/search');
  });

  it('waits for failure tracking before selecting the failover channel', async () => {
    let resolveFailure: (() => void) | null = null;
    let failureRecorded = false;
    let markFailureStarted: (() => void) | null = null;
    const failureStarted = new Promise<void>((resolve) => {
      markFailureStarted = resolve;
    });

    selectChannelMock.mockReturnValueOnce({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'bad-site', url: 'https://bad.example.com', platform: 'openai' },
      account: { id: 33, username: 'bad-user' },
      tokenName: 'default',
      tokenValue: 'sk-bad',
      actualModel: '__search',
    });
    selectNextChannelMock.mockImplementationOnce(() => {
      expect(failureRecorded).toBe(true);
      return {
        channel: { id: 12, routeId: 22 },
        site: { id: 45, name: 'good-site', url: 'https://good.example.com', platform: 'openai' },
        account: { id: 34, username: 'good-user' },
        tokenName: 'default',
        tokenValue: 'sk-good',
        actualModel: '__search',
      };
    });
    recordFailureMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      markFailureStarted?.();
      resolveFailure = () => {
        failureRecorded = true;
        resolve();
      };
    }));
    fetchMock
      .mockResolvedValueOnce(new Response('invalid api key', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: 'search.result', data: [{ title: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const responsePromise = app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        authorization: 'Bearer sk-demo',
      },
      payload: {
        query: 'axonhub',
      },
    });

    await failureStarted;
    expect(selectNextChannelMock).not.toHaveBeenCalled();

    resolveFailure?.();
    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(selectNextChannelMock).toHaveBeenCalledTimes(1);
  });
});
