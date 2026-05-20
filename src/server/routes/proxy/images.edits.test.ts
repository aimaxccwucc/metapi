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
  hasProxyLogCacheColumns: async () => false,
  hasProxyLogClientColumns: async () => false,
  hasProxyLogDownstreamApiKeyIdColumn: async () => false,
  hasProxyLogRouteContextColumns: async () => false,
  schema: {
    proxyLogs: {},
  },
}));

function buildMultipartBody(boundary: string) {
  return Buffer.from(
    `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="model"\r\n\r\n`
      + `gpt-image-1\r\n`
      + `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="prompt"\r\n\r\n`
      + `edit this\r\n`
      + `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="image"; filename="cat.png"\r\n`
      + `Content-Type: image/png\r\n\r\n`
      + `pngdata\r\n`
      + `--${boundary}--\r\n`,
  );
}

describe('/v1/images/edits route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { imagesProxyRoute } = await import('./images.js');
    app = Fastify();
    await app.register(imagesProxyRoute);
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
      actualModel: 'upstream-gpt-image',
    });
    selectNextChannelMock.mockReturnValue(null);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts multipart image edit requests and forwards them to /v1/images/edits', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const boundary = 'metapi-boundary';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer sk-demo',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(boundary),
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://upstream.example.com/v1/images/edits');
  });

  it('returns explicit not-supported error for /v1/images/variations', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/variations',
      payload: {
        model: 'gpt-image-1',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'Image variations are not supported',
        type: 'invalid_request_error',
      },
    });
  });

  it('switches to the next image channel after auth failure on the first source', async () => {
    selectChannelMock.mockReturnValueOnce({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'bad-image-site', url: 'https://bad-image.example.com', platform: 'openai' },
      account: { id: 33, username: 'bad-image-user' },
      tokenName: 'default',
      tokenValue: 'sk-bad-image',
      actualModel: 'gpt-image-1',
    });
    selectNextChannelMock.mockReturnValueOnce({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'good-image-site', url: 'https://good-image.example.com', platform: 'openai' },
      account: { id: 34, username: 'good-image-user' },
      tokenName: 'default',
      tokenValue: 'sk-good-image',
      actualModel: 'gpt-image-1',
    });
    fetchMock
      .mockResolvedValueOnce(new Response('invalid api key', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'iVBORw0KGgo=' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      payload: {
        model: 'gpt-image-1',
        prompt: 'edit this',
        image: 'ignored-for-json-mode',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 401,
      errorText: 'invalid api key',
      modelName: 'gpt-image-1',
    }));
    expect(reportTokenExpiredMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 33,
      siteName: 'bad-image-site',
    }));
    expect(selectNextChannelMock).toHaveBeenCalledTimes(1);
    expect(selectNextChannelMock.mock.calls[0]?.[0]).toBe('gpt-image-1');
    expect(selectNextChannelMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([11]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://good-image.example.com/v1/images/edits');
  });
});
