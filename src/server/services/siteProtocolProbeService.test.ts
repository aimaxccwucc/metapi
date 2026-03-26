import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { dispatchRuntimeRequestMock } = vi.hoisted(() => ({
  dispatchRuntimeRequestMock: vi.fn(),
}));

vi.mock('../routes/proxy/runtimeExecutor.js', () => ({
  dispatchRuntimeRequest: (...args: unknown[]) => dispatchRuntimeRequestMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type SiteProtocolProbeServiceModule = typeof import('./siteProtocolProbeService.js');

describe('siteProtocolProbeService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let probeSiteProtocol: SiteProtocolProbeServiceModule['probeSiteProtocol'];
  let resetSiteProtocolProbeRuntimeState: SiteProtocolProbeServiceModule['resetSiteProtocolProbeRuntimeState'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-protocol-probe-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./siteProtocolProbeService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    probeSiteProtocol = serviceModule.probeSiteProtocol;
    resetSiteProtocolProbeRuntimeState = serviceModule.resetSiteProtocolProbeRuntimeState;
  });

  beforeEach(async () => {
    dispatchRuntimeRequestMock.mockReset();
    resetSiteProtocolProbeRuntimeState();
    await db.delete(schema.settings).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('detects responses after chat protocol mismatch for a direct api token account', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'probe-site',
      url: 'https://probe.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'session-token',
      apiToken: 'sk-account-api',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
    }).run();

    dispatchRuntimeRequestMock.mockImplementation(async ({ request }: { request: { path: string } }) => {
      if (request.path.includes('/v1/chat/completions')) {
        return new Response(JSON.stringify({
          error: { message: 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.' },
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (request.path.includes('/v1/responses')) {
        return new Response(JSON.stringify({ id: 'resp_ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await probeSiteProtocol({ siteId: site.id });

    expect(result.modelName).toBe('gpt-4.1');
    expect(result.accountId).toBe(account.id);
    expect(result.credentialSource).toBe('account_api_token');
    expect(result.supportedEndpoints).toEqual(['responses', 'messages']);
    expect(result.preferredEndpoint).toBe('responses');
    expect(result.protocolConfig).toMatchObject({
      mode: 'manual',
      supportedEndpoints: ['responses', 'messages'],
      preferredEndpoint: 'responses',
    });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      endpoint: 'chat',
      classification: 'protocol_mismatch',
      statusCode: 400,
      ok: false,
    });
    expect(result.attempts[1]).toMatchObject({
      endpoint: 'responses',
      classification: 'supported',
      statusCode: 200,
      ok: true,
    });
  });

  it('prefers managed token credentials and messages for claude-family models', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'claude-site',
      url: 'https://claude-gateway.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'bob',
      accessToken: 'session-token',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-token-probe',
      valueStatus: 'ready',
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'claude-sonnet-4-5-20250929',
      available: true,
    }).run();

    dispatchRuntimeRequestMock.mockImplementation(async ({ request }: { request: { path: string } }) => {
      if (request.path.includes('/v1/messages')) {
        return new Response(JSON.stringify({ id: 'msg_ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await probeSiteProtocol({ siteId: site.id });

    expect(result.modelName).toBe('claude-sonnet-4-5-20250929');
    expect(result.credentialSource).toBe('preferred_token');
    expect(result.supportedEndpoints).toEqual(['messages', 'chat', 'responses']);
    expect(result.preferredEndpoint).toBe('messages');
    expect(result.attempts).toHaveLength(1);
    expect(result.probeSource).toBe('live');
    expect(result.attempts[0]).toMatchObject({
      endpoint: 'messages',
      ok: true,
      classification: 'supported',
    });
  });

  it('falls back to the next candidate when the first candidate has a credential failure', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'fallback-site',
      url: 'https://fallback.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const brokenAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'broken-user',
      accessToken: 'session-broken',
      apiToken: 'sk-broken',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    const healthyAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'healthy-user',
      accessToken: 'session-healthy',
      apiToken: 'sk-healthy',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: brokenAccount.id,
        modelName: 'gpt-4.1',
        available: true,
      },
      {
        accountId: healthyAccount.id,
        modelName: 'gpt-4.1',
        available: true,
      },
    ]).run();

    dispatchRuntimeRequestMock.mockImplementation(async ({ request }: { request: { headers: Record<string, string>; path: string } }) => {
      if (request.headers.Authorization === 'Bearer sk-broken') {
        return new Response(JSON.stringify({
          error: { message: 'invalid api key' },
        }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (request.path.includes('/v1/chat/completions')) {
        return new Response(JSON.stringify({
          error: { message: 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.' },
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'resp_ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await probeSiteProtocol({ siteId: site.id });

    expect(result.accountId).toBe(healthyAccount.id);
    expect(result.credentialSource).toBe('account_api_token');
    expect(result.preferredEndpoint).toBe('responses');
    expect(result.attempts.some((attempt) => attempt.classification === 'credential')).toBe(true);
    expect(result.attempts.at(-1)).toMatchObject({
      endpoint: 'responses',
      ok: true,
    });
  });

  it('ignores non-json success payloads and continues probing the next endpoint', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'non-json-site',
      url: 'https://non-json.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-non-json',
      accessToken: 'session-token',
      apiToken: 'sk-non-json',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
    }).run();

    dispatchRuntimeRequestMock.mockImplementation(async ({ request }: { request: { path: string } }) => {
      if (request.path.includes('/v1/chat/completions')) {
        return new Response('<html>ok</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(JSON.stringify({ id: 'resp_ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await probeSiteProtocol({ siteId: site.id });

    expect(result.preferredEndpoint).toBe('responses');
    expect(result.attempts[0]).toMatchObject({
      endpoint: 'chat',
      ok: false,
      classification: 'inconclusive',
    });
  });

  it('limits protocol probing to a bounded candidate set instead of scanning all available models', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'bounded-site',
      url: 'https://bounded.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const modelNames = [
      'gpt-preferred',
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-5',
      'o3-mini',
      'claude-sonnet',
      'claude-haiku',
      'deepseek-chat',
      'qwen-max',
    ];

    for (let i = 0; i < modelNames.length; i += 1) {
      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: `probe-user-${i + 1}`,
        accessToken: `session-${i + 1}`,
        apiToken: `sk-probe-${i + 1}`,
        status: 'active',
        extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
      }).returning().get();

      await db.insert(schema.modelAvailability).values({
        accountId: account.id,
        modelName: modelNames[i],
        available: true,
      }).run();
    }

    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'invalid api key' },
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(probeSiteProtocol({
      siteId: site.id,
      modelName: 'gpt-preferred',
    })).rejects.toMatchObject({
      name: 'SiteProtocolProbeError',
      attempts: expect.any(Array),
      attemptSummary: expect.any(Array),
    });

    const touchedCredentials = new Set(
      dispatchRuntimeRequestMock.mock.calls
        .map((call) => {
          const headers = (call[0] as { request?: { headers?: Record<string, string> } })?.request?.headers || {};
          return String(headers.Authorization || headers.authorization || headers['x-api-key'] || '').trim();
        })
        .filter((value) => value.length > 0),
    );
    expect(touchedCredentials.size).toBeLessThanOrEqual(6);
  });

  it('returns cached probe results without repeating network probes inside the ttl window', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cache-site',
      url: 'https://cache.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cache-user',
      accessToken: 'session-cache',
      apiToken: 'sk-cache',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
    }).run();

    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({ id: 'resp_ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const first = await probeSiteProtocol({ siteId: site.id });
    const second = await probeSiteProtocol({ siteId: site.id });

    expect(first.probeSource).toBe('live');
    expect(second.probeSource).toBe('cache');
    expect(second.cacheHit).toBe(true);
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
  });

  it('enters cooldown after a failed probe and returns structured failure metadata', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cooldown-site',
      url: 'https://cooldown.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cooldown-user',
      accessToken: 'session-cooldown',
      apiToken: 'sk-cooldown',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
    }).run();

    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'invalid api key' },
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(probeSiteProtocol({ siteId: site.id })).rejects.toMatchObject({
      name: 'SiteProtocolProbeError',
      probeSource: 'live',
      attemptSummary: expect.any(Array),
      cooldownUntilMs: expect.any(Number),
    });
    const callCountAfterFirstFailure = dispatchRuntimeRequestMock.mock.calls.length;
    await expect(probeSiteProtocol({ siteId: site.id })).rejects.toMatchObject({
      name: 'SiteProtocolProbeError',
      probeSource: 'cooldown_cache',
      attempts: expect.any(Array),
      attemptSummary: expect.any(Array),
    });
    expect(dispatchRuntimeRequestMock.mock.calls.length).toBe(callCountAfterFirstFailure);
  });
});
