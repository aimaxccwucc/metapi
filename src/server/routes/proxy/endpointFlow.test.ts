import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { executeEndpointFlow, type BuiltEndpointRequest } from './endpointFlow.js';

vi.mock('undici', () => ({
  fetch: vi.fn(),
}));

const fetchMock = vi.mocked(fetch);

function requestFor(path: string): BuiltEndpointRequest {
  return {
    endpoint: 'responses',
    path,
    headers: { 'content-type': 'application/json' },
    body: { model: 'gpt-5.2', input: 'hello' },
  };
}

function toUndiciResponse(response: Response): Awaited<ReturnType<typeof fetch>> {
  return response as unknown as Awaited<ReturnType<typeof fetch>>;
}

describe('executeEndpointFlow', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('returns the first successful upstream response', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.upstreamPath).toBe('/v1/responses');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('downgrades to next endpoint when policy allows', async () => {
    fetchMock
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
        error: { message: 'unsupported endpoint', type: 'invalid_request_error' },
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })))
      .mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));

    const downgradedPaths: string[] = [];
    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses', 'chat'],
      buildRequest: (endpoint) => endpoint === 'responses'
        ? requestFor('/v1/responses')
        : { ...requestFor('/v1/chat/completions'), endpoint },
      shouldDowngrade: () => true,
      onDowngrade: (ctx) => {
        downgradedPaths.push(ctx.request.path);
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.upstreamPath).toBe('/v1/chat/completions');
    }
    expect(downgradedPaths).toEqual(['/v1/responses']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts recovered response from tryRecover hook', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
      error: { message: 'upstream_error', type: 'upstream_error' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));

    const recovered = toUndiciResponse(new Response(JSON.stringify({ ok: 'recovered' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
      tryRecover: async () => ({
        upstream: recovered,
        upstreamPath: '/v1/responses',
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.upstreamPath).toBe('/v1/responses');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns normalized final error when all endpoints fail', async () => {
    fetchMock.mockResolvedValueOnce(toUndiciResponse(new Response(JSON.stringify({
      error: { message: 'upstream_error', type: 'upstream_error' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));

    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.errText).toContain('[upstream:/v1/responses]');
      expect(result.errText).toContain('Upstream returned HTTP 400');
    }
  });
});
