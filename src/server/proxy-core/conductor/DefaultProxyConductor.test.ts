import { describe, expect, it, vi } from 'vitest';

import { DefaultProxyConductor } from './DefaultProxyConductor.js';
import { terminalStreamFailure } from './streamTermination.js';

const baseSelectedChannel = {
  channel: { id: 11, routeId: 22 },
  site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
  account: { id: 33, username: 'demo-user' },
  tokenName: 'default',
  tokenValue: 'sk-demo',
  actualModel: 'upstream-gpt',
};

describe('DefaultProxyConductor', () => {
  it('returns the first selected channel when the first attempt succeeds', async () => {
    const selectChannel = vi.fn().mockResolvedValue(baseSelectedChannel);
    const selectNextChannel = vi.fn();
    const recordSuccess = vi.fn().mockResolvedValue(undefined);
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel,
      recordSuccess,
      recordFailure,
    });
    const attempt = vi.fn().mockResolvedValue({
      ok: true,
      response: new Response('ok', { status: 200 }),
      latencyMs: 12,
      cost: 0.25,
    });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 3,
    });

    expect(result).toMatchObject({
      ok: true,
      selected: baseSelectedChannel,
      attempts: 1,
    });
    expect(selectChannel).toHaveBeenCalledWith('gpt-5.4', undefined);
    expect(selectNextChannel).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(recordSuccess).toHaveBeenCalledWith(11, {
      latencyMs: 12,
      cost: 0.25,
    });
  });

  it('retries on the same channel when the attempt asks for a same-channel retry', async () => {
    const selectChannel = vi.fn().mockResolvedValue(baseSelectedChannel);
    const selectNextChannel = vi.fn();
    const recordSuccess = vi.fn().mockResolvedValue(undefined);
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel,
      recordSuccess,
      recordFailure,
    });
    const attempt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        action: 'retry_same_channel',
        status: 429,
        rawErrorText: 'rate limited',
      })
      .mockResolvedValueOnce({
        ok: true,
        response: new Response('ok', { status: 200 }),
      });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 3,
    });

    expect(result).toMatchObject({
      ok: true,
      attempts: 2,
    });
    expect(selectNextChannel).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(recordFailure).toHaveBeenCalledWith(11, {
      status: 429,
      rawErrorText: 'rate limited',
      retryAfterHeader: null,
      retryAfterMs: null,
    });
  });

  it('fails over to the next channel when the attempt asks for failover', async () => {
    const nextSelectedChannel = {
      ...baseSelectedChannel,
      channel: { id: 12, routeId: 22 },
      tokenValue: 'sk-next',
    };
    const selectChannel = vi.fn().mockResolvedValue(baseSelectedChannel);
    const selectNextChannel = vi.fn().mockResolvedValue(nextSelectedChannel);
    const recordSuccess = vi.fn().mockResolvedValue(undefined);
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel,
      recordSuccess,
      recordFailure,
    });
    const attempt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        action: 'failover',
        status: 503,
        rawErrorText: 'upstream unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        response: new Response('ok', { status: 200 }),
      });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 3,
      getFailoverSiteId: (selected) => Number(selected.site.id),
    });

    expect(result).toMatchObject({
      ok: true,
      selected: nextSelectedChannel,
      attempts: 2,
    });
    expect(selectNextChannel).toHaveBeenCalledWith('gpt-5.4', [11], undefined, new Set());
    expect(recordFailure).toHaveBeenCalledWith(11, {
      status: 503,
      rawErrorText: 'upstream unavailable',
      retryAfterHeader: null,
      retryAfterMs: null,
    });
    expect(recordSuccess).toHaveBeenCalledWith(12, {
      latencyMs: null,
      cost: null,
    });
  });

  it('allows one same-site fallback before excluding the whole site', async () => {
    const sameSiteChannel = {
      ...baseSelectedChannel,
      channel: { id: 12, routeId: 22 },
      tokenValue: 'sk-same-site',
    };
    const otherSiteChannel = {
      ...baseSelectedChannel,
      channel: { id: 13, routeId: 22 },
      site: { id: 45, name: 'other-site', url: 'https://other-upstream.example.com', platform: 'openai' },
      tokenValue: 'sk-other-site',
    };
    const selectChannel = vi.fn().mockResolvedValue(baseSelectedChannel);
    const selectNextChannel = vi.fn()
      .mockResolvedValueOnce(sameSiteChannel)
      .mockResolvedValueOnce(otherSiteChannel);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel,
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    });
    const attempt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        action: 'failover',
        status: 503,
        rawErrorText: 'upstream unavailable',
      })
      .mockResolvedValueOnce({
        ok: false,
        action: 'failover',
        status: 503,
        rawErrorText: 'upstream still unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        response: new Response('ok', { status: 200 }),
      });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 4,
      getFailoverSiteId: (selected) => Number(selected.site.id),
    });

    expect(result).toMatchObject({
      ok: true,
      selected: otherSiteChannel,
      attempts: 3,
    });
    expect(selectNextChannel).toHaveBeenNthCalledWith(1, 'gpt-5.4', [11], undefined, new Set());
    expect(selectNextChannel).toHaveBeenNthCalledWith(2, 'gpt-5.4', [11, 12], undefined, new Set([44]));
  });

  it('excludes site immediately after blocked_invalid_request failover', async () => {
    const otherSiteChannel = {
      ...baseSelectedChannel,
      channel: { id: 13, routeId: 22 },
      site: { id: 45, name: 'other-site', url: 'https://other-upstream.example.com', platform: 'openai' },
      tokenValue: 'sk-other-site',
    };
    const selectChannel = vi.fn().mockResolvedValue(baseSelectedChannel);
    const selectNextChannel = vi.fn().mockResolvedValue(otherSiteChannel);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel,
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    });
    const attempt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        action: 'failover',
        status: 400,
        rawErrorText: 'blocked_invalid_request: request body matches a previously blocked invalid request',
      })
      .mockResolvedValueOnce({
        ok: true,
        response: new Response('ok', { status: 200 }),
      });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 3,
      getFailoverSiteId: (selected) => Number(selected.site.id),
    });

    expect(result).toMatchObject({
      ok: true,
      selected: otherSiteChannel,
      attempts: 2,
    });
    expect(selectNextChannel).toHaveBeenCalledWith('gpt-5.4', [11], undefined, new Set([44]));
  });

  it('excludes site immediately after tool_choice compatibility failover', async () => {
    const otherSiteChannel = {
      ...baseSelectedChannel,
      channel: { id: 13, routeId: 22 },
      site: { id: 45, name: 'other-site', url: 'https://other-upstream.example.com', platform: 'openai' },
      tokenValue: 'sk-other-site',
    };
    const selectChannel = vi.fn().mockResolvedValue(baseSelectedChannel);
    const selectNextChannel = vi.fn().mockResolvedValue(otherSiteChannel);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel,
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    });
    const attempt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        action: 'failover',
        status: 400,
        rawErrorText: "Unknown parameter: 'tool_choice.function'.",
      })
      .mockResolvedValueOnce({
        ok: true,
        response: new Response('ok', { status: 200 }),
      });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 3,
      getFailoverSiteId: (selected) => Number(selected.site.id),
    });

    expect(result).toMatchObject({
      ok: true,
      selected: otherSiteChannel,
      attempts: 2,
    });
    expect(selectNextChannel).toHaveBeenCalledWith('gpt-5.4', [11], undefined, new Set([44]));
  });

  it('excludes site immediately after empty-content failover', async () => {
    const otherSiteChannel = {
      ...baseSelectedChannel,
      channel: { id: 13, routeId: 22 },
      site: { id: 45, name: 'other-site', url: 'https://other-upstream.example.com', platform: 'openai' },
      tokenValue: 'sk-other-site',
    };
    const selectChannel = vi.fn().mockResolvedValue(baseSelectedChannel);
    const selectNextChannel = vi.fn().mockResolvedValue(otherSiteChannel);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel,
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    });
    const attempt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        action: 'failover',
        status: 502,
        rawErrorText: '[upstream:/v1/chat/completions] Upstream returned empty content',
      })
      .mockResolvedValueOnce({
        ok: true,
        response: new Response('ok', { status: 200 }),
      });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 3,
      getFailoverSiteId: (selected) => Number(selected.site.id),
    });

    expect(result).toMatchObject({
      ok: true,
      selected: otherSiteChannel,
      attempts: 2,
    });
    expect(selectNextChannel).toHaveBeenCalledWith('gpt-5.4', [11], undefined, new Set([44]));
  });

  it('excludes site immediately after transient gateway failover', async () => {
    const otherSiteChannel = {
      ...baseSelectedChannel,
      channel: { id: 13, routeId: 22 },
      site: { id: 45, name: 'other-site', url: 'https://other-upstream.example.com', platform: 'openai' },
      tokenValue: 'sk-other-site',
    };
    const selectChannel = vi.fn().mockResolvedValue(baseSelectedChannel);
    const selectNextChannel = vi.fn().mockResolvedValue(otherSiteChannel);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel,
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    });
    const attempt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        action: 'failover',
        status: 503,
        rawErrorText: '[upstream:/v1/chat/completions] Upstream returned HTTP 503: Service temporarily unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        response: new Response('ok', { status: 200 }),
      });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 3,
      getFailoverSiteId: (selected) => Number(selected.site.id),
    });

    expect(result).toMatchObject({
      ok: true,
      selected: otherSiteChannel,
      attempts: 2,
    });
    expect(selectNextChannel).toHaveBeenCalledWith('gpt-5.4', [11], undefined, new Set([44]));
  });

  it('excludes site immediately after codex fast-fail timeout', async () => {
    const otherSiteChannel = {
      ...baseSelectedChannel,
      channel: { id: 13, routeId: 22 },
      site: { id: 45, name: 'other-site', url: 'https://other-upstream.example.com', platform: 'openai' },
      tokenValue: 'sk-other-site',
    };
    const selectChannel = vi.fn().mockResolvedValue(baseSelectedChannel);
    const selectNextChannel = vi.fn().mockResolvedValue(otherSiteChannel);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel,
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    });
    const attempt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        action: 'failover',
        status: 502,
        rawErrorText: 'Upstream error: upstream timeout after 4000ms',
      })
      .mockResolvedValueOnce({
        ok: true,
        response: new Response('ok', { status: 200 }),
      });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 3,
      getFailoverSiteId: (selected) => Number(selected.site.id),
    });

    expect(result).toMatchObject({
      ok: true,
      selected: otherSiteChannel,
      attempts: 2,
    });
    expect(selectNextChannel).toHaveBeenCalledWith('gpt-5.4', [11], undefined, new Set([44]));
  });

  it('excludes site immediately after auth_unavailable failover', async () => {
    const otherSiteChannel = {
      ...baseSelectedChannel,
      channel: { id: 13, routeId: 22 },
      site: { id: 45, name: 'other-site', url: 'https://other-upstream.example.com', platform: 'openai' },
      tokenValue: 'sk-other-site',
    };
    const selectChannel = vi.fn().mockResolvedValue(baseSelectedChannel);
    const selectNextChannel = vi.fn().mockResolvedValue(otherSiteChannel);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel,
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    });
    const attempt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        action: 'failover',
        status: 500,
        rawErrorText: '[upstream:/v1/chat/completions] Upstream returned HTTP 500: auth_unavailable: no auth available',
      })
      .mockResolvedValueOnce({
        ok: true,
        response: new Response('ok', { status: 200 }),
      });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 3,
      getFailoverSiteId: (selected) => Number(selected.site.id),
    });

    expect(result).toMatchObject({
      ok: true,
      selected: otherSiteChannel,
      attempts: 2,
    });
    expect(selectNextChannel).toHaveBeenCalledWith('gpt-5.4', [11], undefined, new Set([44]));
  });

  it('refreshes auth on 401 and retries the same channel with the refreshed selection', async () => {
    const refreshedChannel = {
      ...baseSelectedChannel,
      tokenValue: 'sk-refreshed',
    };
    const refreshAuth = vi.fn().mockResolvedValue(refreshedChannel);
    const conductor = new DefaultProxyConductor({
      selectChannel: vi.fn().mockResolvedValue(baseSelectedChannel),
      selectNextChannel: vi.fn(),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      refreshAuth,
    });
    const attempt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        action: 'refresh_auth',
        status: 401,
        rawErrorText: 'expired token',
      })
      .mockResolvedValueOnce({
        ok: true,
        response: new Response('ok', { status: 200 }),
      });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      maxAttempts: 3,
    });

    expect(result).toMatchObject({
      ok: true,
      selected: refreshedChannel,
      attempts: 2,
    });
    expect(refreshAuth).toHaveBeenCalledWith(baseSelectedChannel, {
      status: 401,
      rawErrorText: 'expired token',
      retryAfterHeader: null,
      retryAfterMs: null,
    });
  });

  it('calls refreshSelection once when the first select returns no channel', async () => {
    const selectChannel = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(baseSelectedChannel);
    const conductor = new DefaultProxyConductor({
      selectChannel,
      selectNextChannel: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      previewSelectedChannel: vi.fn().mockResolvedValue(null),
    });

    expect(await conductor.previewSelectedChannel('gpt-5.4')).toBe(null);

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt: vi.fn().mockResolvedValue({
        ok: true,
        response: new Response('ok', { status: 200 }),
      }),
      refreshSelection: async () => selectChannel('gpt-5.4', undefined),
      maxAttempts: 2,
    });

    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(selectChannel).toHaveBeenCalledTimes(2);
  });

  it('returns a no_channel result when no channel is available', async () => {
    const onNoChannel = vi.fn().mockResolvedValue(undefined);
    const conductor = new DefaultProxyConductor({
      selectChannel: vi.fn().mockResolvedValue(null),
      selectNextChannel: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      previewSelectedChannel: vi.fn().mockResolvedValue(null),
    });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt: vi.fn(),
      onNoChannel,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'no_channel',
      attempts: 0,
    });
    expect(onNoChannel).toHaveBeenCalledWith({ attempts: 0 });
  });

  it('propagates terminal stream failures and calls the terminal failure hook', async () => {
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);
    const conductor = new DefaultProxyConductor({
      selectChannel: vi.fn().mockResolvedValue(baseSelectedChannel),
      selectNextChannel: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    });
    const attempt = vi.fn().mockResolvedValue({
      ok: false,
      ...terminalStreamFailure({
        status: 502,
        rawErrorText: 'stream disconnected before completion',
      }),
    });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      attempt,
      onTerminalFailure,
      maxAttempts: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'terminal',
      selected: baseSelectedChannel,
      status: 502,
      rawErrorText: 'stream disconnected before completion',
      attempts: 1,
    });
    expect(onTerminalFailure).toHaveBeenCalledWith(baseSelectedChannel, {
      status: 502,
      rawErrorText: 'stream disconnected before completion',
      retryAfterHeader: null,
      retryAfterMs: null,
    });
  });

  it('propagates Retry-After failure metadata to hooks and results', async () => {
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const conductor = new DefaultProxyConductor({
      selectChannel: vi.fn().mockResolvedValue(baseSelectedChannel),
      selectNextChannel: vi.fn().mockResolvedValue(null),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure,
    });

    const result = await conductor.execute({
      requestedModel: 'gpt-5.4',
      maxAttempts: 1,
      attempt: vi.fn().mockResolvedValue({
        ok: false,
        action: 'failover',
        status: 429,
        rawErrorText: 'rate limited',
        retryAfterHeader: '12',
        retryAfterMs: 12_000,
      }),
    });

    expect(recordFailure).toHaveBeenCalledWith(11, {
      status: 429,
      rawErrorText: 'rate limited',
      retryAfterHeader: '12',
      retryAfterMs: 12_000,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'failed',
      status: 429,
      rawErrorText: 'rate limited',
      retryAfterHeader: '12',
      retryAfterMs: 12_000,
      attempts: 1,
    });
  });
});
