import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

describe('testRoutes proxy tester transport', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { testRoutes } = await import('./test.js');
    app = Fastify();
    await app.register(testRoutes);
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects proxy test paths outside the whitelist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy',
      payload: {
        method: 'POST',
        path: '/api/accounts',
        requestKind: 'json',
        stream: false,
        jobMode: false,
        rawMode: false,
        jsonBody: {},
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'path is not allowed: /api/accounts',
        type: 'validation_error',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards raw json bodies without dropping unknown fields', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: 'response',
      output_text: 'ok',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy',
      payload: {
        method: 'POST',
        path: '/v1/responses',
        requestKind: 'json',
        stream: false,
        jobMode: false,
        rawMode: true,
        rawJsonText: JSON.stringify({
          model: 'gpt-4o-mini',
          include: ['reasoning.encrypted_content'],
          metadata: { source: 'playground' },
          custom_field: 'keep-me',
        }),
      },
    });

    expect(response.statusCode).toBe(200);
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/responses$/);
    expect(JSON.parse(String(requestInit.body))).toEqual({
      model: 'gpt-4o-mini',
      include: ['reasoning.encrypted_content'],
      metadata: { source: 'playground' },
      custom_field: 'keep-me',
      stream: false,
    });
  });

  it('translates legacy claude chat tests through the compatibility wrapper', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      type: 'message',
      content: [{ type: 'text', text: 'pong' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/chat',
      payload: {
        model: 'claude-3-7-sonnet',
        targetFormat: 'claude',
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'ping' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/messages$/);
    expect(JSON.parse(String(requestInit.body))).toEqual({
      model: 'claude-3-7-sonnet',
      stream: false,
      max_tokens: 4096,
      system: 'be concise',
      messages: [
        { role: 'user', content: 'ping' },
      ],
    });
  });

  it('accepts stream=true when creating proxy jobs and stores a pending job', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy/jobs',
      payload: {
        method: 'POST',
        path: '/v1/chat/completions',
        requestKind: 'json',
        stream: true,
        jobMode: true,
        rawMode: false,
        jsonBody: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: 'pending',
    });
  });
});
