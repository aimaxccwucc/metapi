import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const getProxyAuthContextMock = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  getProxyAuthContext: (...args: unknown[]) => getProxyAuthContextMock(...args),
}));

describe('getDownstreamRoutingPolicy', () => {
  it('derives sticky session key from managed key and client session context', async () => {
    getProxyAuthContextMock.mockReturnValue({
      source: 'managed',
      keyId: 42,
      token: 'sk-managed',
      keyName: 'managed-key',
      policy: {
        supportedModels: ['gpt-5.2'],
        allowedRouteIds: [7],
        siteWeightMultipliers: { 1: 1.2 },
      },
    });

    const { getDownstreamRoutingPolicy } = await import('./downstreamPolicy.js');
    const app = Fastify();
    app.post('/v1/chat/completions', async (request) => getDownstreamRoutingPolicy(request));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        originator: 'codex_cli_rs',
        Session_id: 'codex-session-abc',
      },
      payload: {
        model: 'gpt-5.2',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      supportedModels: ['gpt-5.2'],
      allowedRouteIds: [7],
      siteWeightMultipliers: { 1: 1.2 },
      stickySessionKey: 'mk:42:/v1/chat/completions:codex-session-abc',
      publicRoutesOnly: true,
    });

    await app.close();
  });

  it('falls back to client app identity when session id is unavailable', async () => {
    getProxyAuthContextMock.mockReturnValue({
      source: 'global',
      keyId: null,
      token: 'global-token',
      keyName: 'global',
      policy: {
        supportedModels: [],
        allowedRouteIds: [],
        siteWeightMultipliers: {},
      },
    });

    const { getDownstreamRoutingPolicy } = await import('./downstreamPolicy.js');
    const app = Fastify();
    app.post('/v1/search', async (request) => getDownstreamRoutingPolicy(request));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        'x-title': 'Cherry Studio',
        'http-referer': 'https://cherry-ai.com',
      },
      payload: {
        query: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stickySessionKey: 'global:global:/v1/search:cherry_studio',
      publicRoutesOnly: true,
    });

    await app.close();
  });

  it('defaults to public routes only when auth context is missing', async () => {
    getProxyAuthContextMock.mockReturnValue(null);

    const { getDownstreamRoutingPolicy } = await import('./downstreamPolicy.js');
    const app = Fastify();
    app.post('/v1/chat/completions', async (request) => getDownstreamRoutingPolicy(request));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      supportedModels: [],
      allowedRouteIds: [],
      siteWeightMultipliers: {},
      stickySessionKey: null,
      publicRoutesOnly: true,
    });

    await app.close();
  });
});
