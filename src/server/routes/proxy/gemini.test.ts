import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const recordFailureMock = vi.fn();
const invalidateTokenRouterCacheMock = vi.fn();
const authorizeDownstreamTokenMock = vi.fn();
const consumeManagedKeyRequestMock = vi.fn();

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
    explainSelection: vi.fn(async () => ({ selectedChannelId: 11 })),
  },
  invalidateTokenRouterCache: (...args: unknown[]) => invalidateTokenRouterCacheMock(...args),
}));

vi.mock('../../services/downstreamApiKeyService.js', () => ({
  authorizeDownstreamToken: (...args: unknown[]) => authorizeDownstreamTokenMock(...args),
  consumeManagedKeyRequest: (...args: unknown[]) => consumeManagedKeyRequestMock(...args),
}));

describe('gemini native proxy routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { proxyRoutes } = await import('./router.js');
    app = Fastify();
    await app.register(proxyRoutes);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    recordFailureMock.mockReset();
    authorizeDownstreamTokenMock.mockReset();
    consumeManagedKeyRequestMock.mockReset();

    authorizeDownstreamTokenMock.mockResolvedValue({
      ok: true,
      source: 'global',
      token: 'sk-managed-gemini',
      policy: {},
    });

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'gemini-site', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'gemini-key',
      actualModel: 'gemini-2.5-flash',
    });
    selectNextChannelMock.mockReturnValue(null);
    recordFailureMock.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts x-goog-api-key on /v1beta/models and returns gemini model list shape', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
        },
      ],
    });
  });

  it('falls back to the next channel for listModels when first Gemini channel fails', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'first channel failed' },
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toContain('key=gemini-key');
    expect(secondUrl).toContain('key=gemini-key-2');
  });

  it('forwards native generateContent requests through the gemini route group', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'hello from gemini' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(targetUrl).toContain('key=gemini-key');
    expect(JSON.parse(String(requestInit.body))).toEqual({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello' }],
        },
      ],
    });
    expect(response.json()).toEqual({
      responseId: '',
      modelVersion: '',
      candidates: [
        {
          index: 0,
          content: {
            parts: [{ text: 'hello from gemini' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });
  });

  it('preserves structured Gemini-native fields instead of narrowing them to a bare passthrough shell', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'ok' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
        cachedContentTokenCount: 2,
        thoughtsTokenCount: 1,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
      payload: {
        systemInstruction: {
          parts: [{ text: 'be concise' }],
        },
        cachedContent: 'cached/abc123',
        safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
        generationConfig: {
          responseModalities: ['TEXT'],
          responseMimeType: 'application/json',
          temperature: 0.2,
          topP: 0.8,
          topK: 20,
          maxOutputTokens: 256,
          thinkingConfig: { thinkingBudget: 512 },
          imageConfig: { aspectRatio: '1:1' },
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'lookup_weather',
                description: 'look up weather',
              },
            ],
          },
        ],
        contents: [
          {
            role: 'user',
            parts: [{ text: 'weather in shanghai' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toEqual({
      systemInstruction: {
        parts: [{ text: 'be concise' }],
      },
      cachedContent: 'cached/abc123',
      safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
      generationConfig: {
        responseModalities: ['TEXT'],
        responseMimeType: 'application/json',
        temperature: 0.2,
        topP: 0.8,
        topK: 20,
        maxOutputTokens: 256,
        thinkingConfig: { thinkingBudget: 512 },
        imageConfig: { aspectRatio: '1:1' },
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookup_weather',
              description: 'look up weather',
            },
          ],
        },
      ],
      contents: [
        {
          role: 'user',
          parts: [{ text: 'weather in shanghai' }],
        },
      ],
    });
  });

  it('aggregates non-sse json-array streaming payloads into a final Gemini response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'first' }] },
            groundingMetadata: { source: 'web' },
          },
        ],
      },
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'second', thoughtSignature: 'sig-1' }] },
            citationMetadata: { citations: [{ startIndex: 0, endIndex: 5 }] },
          },
        ],
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 6,
          totalTokenCount: 17,
          cachedContentTokenCount: 2,
          thoughtsTokenCount: 3,
        },
      },
    ]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      responseId: '',
      modelVersion: '',
      candidates: [
        {
          index: 0,
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { text: 'first' },
              { text: 'second', thoughtSignature: 'sig-1' },
            ],
          },
          groundingMetadata: { source: 'web' },
          citationMetadata: { citations: [{ startIndex: 0, endIndex: 5 }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 6,
        totalTokenCount: 17,
        cachedContentTokenCount: 2,
        thoughtsTokenCount: 3,
      },
    });
  });

  it('derives gemini-3 thinkingLevel from OpenAI-style reasoning inputs in the runtime request path', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'gemini-site', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'gemini-key',
      actualModel: 'gemini-3-pro',
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'ok' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-pro:generateContent',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
      payload: {
        reasoning_effort: 'high',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toEqual({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello' }],
        },
      ],
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'high' },
      },
    });
  });

  it('aggregates SSE payloads through the transformer instead of raw passthrough', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"responseId":"resp-sse","modelVersion":"gemini-2.5-flash","candidates":[{"content":{"role":"model","parts":[{"text":"first"}]},"groundingMetadata":{"source":"web"}}]}\r\n\r\n'));
        controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"second","thoughtSignature":"sig-1"}]},"citationMetadata":{"citations":[{"startIndex":0,"endIndex":5}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":6,"totalTokenCount":17,"cachedContentTokenCount":2,"thoughtsTokenCount":3}}\r\n\r\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('data: {"responseId":"resp-sse"');
    expect(response.body).toContain('"groundingMetadata":{"source":"web"}');
    expect(response.body).toContain('"citationMetadata":{"citations":[{"startIndex":0,"endIndex":5}]}');
    expect(response.body).toContain('"cachedContentTokenCount":2');
    expect(response.body).toContain('"thoughtsTokenCount":3');
    expect(response.body).toContain('"parts":[{"text":"first"},{"text":"second","thoughtSignature":"sig-1"}]');
    expect(response.body).not.toContain('\r\n\r\n');
  });

  it('falls back to the next channel when first Gemini channel returns 400 before any bytes are written', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'bad request on first channel' },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok from fallback' }] },
            finishReason: 'STOP',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toContain('key=gemini-key');
    expect(secondUrl).toContain('key=gemini-key-2');
    expect(response.json().candidates?.[0]?.content?.parts?.[0]?.text).toContain('ok from fallback');
  });

  it('falls back to the next channel when first Gemini channel returns 403 before any bytes are written', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'forbidden on first channel' },
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok from fallback' }] },
            finishReason: 'STOP',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11);
  });

  it('falls back to the next channel when first Gemini channel returns 500 before any bytes are written', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock
      .mockResolvedValueOnce(new Response('upstream crash', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok from fallback' }] },
            finishReason: 'STOP',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11);
  });

  it('falls back to the next channel when first Gemini channel throws before any bytes are written', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    fetchMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok from fallback' }] },
            finishReason: 'STOP',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11);
  });

  it('falls back to the next channel for SSE requests before any bytes are written', async () => {
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'gemini-site-2', url: 'https://generativelanguage.googleapis.com', platform: 'gemini' },
      account: { id: 34, username: 'demo-user-2' },
      tokenName: 'fallback',
      tokenValue: 'gemini-key-2',
      actualModel: 'gemini-2.5-flash',
    });

    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"responseId":"resp-fallback","candidates":[{"content":{"role":"model","parts":[{"text":"hello from fallback sse"}]},"finishReason":"STOP"}]}\r\n\r\n'));
        controller.close();
      },
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'upstream unavailable' },
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(upstreamBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      headers: {
        'x-goog-api-key': 'sk-managed-gemini',
      },
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordFailureMock).toHaveBeenCalledWith(11);
    expect(response.body).toContain('hello from fallback sse');
  });
});
