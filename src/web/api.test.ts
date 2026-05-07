import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ProxyTestRequestEnvelope } from './api.js';
import { getAuthToken, persistAuthSession } from './authSession.js';

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
}

function installPendingFetch() {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api proxy test timeout handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', createMemoryStorage());
    persistAuthSession(globalThis.localStorage as Storage, 'token-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps image generation proxy tests alive past the default 30 second timeout', async () => {
    installPendingFetch();

    const payload: ProxyTestRequestEnvelope = {
      method: 'POST',
      path: '/v1/images/generations',
      requestKind: 'json',
      jsonBody: {
        model: 'gemini-imagen',
        prompt: 'banana cat',
      },
    };

    let settled = false;
    const promise = api.proxyTest(payload);
    const handled = promise
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected image generation proxy test to time out');
    }
    expect(result.error.message).toBe('请求超时（150s）');
  });

  it('still uses the default 30 second timeout for generic proxy tests', async () => {
    installPendingFetch();

    const payload: ProxyTestRequestEnvelope = {
      method: 'POST',
      path: '/v1/embeddings',
      requestKind: 'json',
      jsonBody: {
        model: 'text-embedding-3-small',
        input: 'hello',
      },
    };

    const promise = api.proxyTest(payload).catch((error: Error) => error);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toMatchObject({ message: '请求超时（30s）' });
  });

  it('keeps marketplace pricing hydration alive for slow first aggregation', async () => {
    installPendingFetch();

    let settled = false;
    const promise = api.getModelsMarketplace({ includePricing: true })
      .catch((error: Error) => error)
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(105_000);
    await expect(promise).resolves.toMatchObject({ message: '请求超时（150s）' });
  });

  it('times out replay hydration file-content fetches after 30 seconds', async () => {
    installPendingFetch();

    const getProxyFileContentDataUrl = (api as Record<string, any>).getProxyFileContentDataUrl;
    let settled = false;
    const handled = getProxyFileContentDataUrl?.('file-metapi-123')
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(true);

    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected replay hydration file-content fetch to time out');
    }
    expect(result.error.message).toBe('请求超时（30s）');
  });

  it('loads proxy file content as a data URL for replay hydration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      new Blob([Buffer.from('PDF')], { type: 'application/pdf' }),
      {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'inline; filename="brief.pdf"',
        },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const getProxyFileContentDataUrl = (api as Record<string, any>).getProxyFileContentDataUrl;
    const result = await getProxyFileContentDataUrl?.('file-metapi-123');

    expect(fetchMock).toHaveBeenCalledWith('/api/test/proxy/files/file-metapi-123/content', expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
      headers: {},
    }));
    expect(result).toEqual({
      filename: 'brief.pdf',
      mimeType: 'application/pdf',
      data: 'data:application/pdf;base64,UERG',
    });
  });

  it('uses same-origin credentials for admin session APIs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, active: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.createAdminSession('admin-token');
    await api.getAdminSession();
    await api.clearAdminSession();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/auth/session', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'admin-token' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/session', expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/auth/session', expect.objectContaining({
      method: 'DELETE',
      credentials: 'same-origin',
    }));
  });

  it('adds an empty json body for authenticated POST requests without explicit payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.checkModels(27);

    expect(fetchMock).toHaveBeenCalledWith('/api/models/check/27', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: '{}',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
      }),
    }));
  });

  it('does not add a json body for authenticated DELETE requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.deleteAccount(27);

    expect(fetchMock).toHaveBeenCalledWith('/api/accounts/27', expect.objectContaining({
      method: 'DELETE',
      credentials: 'same-origin',
      headers: expect.objectContaining({}),
    }));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBeUndefined();
  });

  it('keeps the local session when a forbidden business request does not invalidate the admin session', async () => {
    const reloadMock = vi.fn();
    vi.stubGlobal('window', {
      location: {
        reload: reloadMock,
      },
    } as unknown as Window & typeof globalThis);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'IP not allowed' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, active: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getSites()).rejects.toThrow('IP not allowed');
    expect(getAuthToken(globalThis.localStorage as Storage)).toBeTruthy();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('clears the local session only after the admin session probe confirms expiry', async () => {
    const reloadMock = vi.fn();
    vi.stubGlobal('window', {
      location: {
        reload: reloadMock,
      },
    } as unknown as Window & typeof globalThis);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, active: false }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getSites()).rejects.toThrow('Session expired');
    expect(getAuthToken(globalThis.localStorage as Storage)).toBeNull();
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the local session for stream requests when a forbidden response does not invalidate the admin session', async () => {
    const reloadMock = vi.fn();
    vi.stubGlobal('window', {
      location: {
        reload: reloadMock,
      },
    } as unknown as Window & typeof globalThis);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'IP not allowed' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, active: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.proxyTestStream({
      method: 'POST',
      path: '/v1/responses',
      requestKind: 'json',
      jsonBody: { model: 'gpt-5', input: 'hello' },
    })).rejects.toThrow('IP not allowed');
    expect(getAuthToken(globalThis.localStorage as Storage)).toBeTruthy();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('clears the local session for stream requests only after the admin session probe confirms expiry', async () => {
    const reloadMock = vi.fn();
    vi.stubGlobal('window', {
      location: {
        reload: reloadMock,
      },
    } as unknown as Window & typeof globalThis);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, active: false }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.testChatStream({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toThrow('Session expired');
    expect(getAuthToken(globalThis.localStorage as Storage)).toBeNull();
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
