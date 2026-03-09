import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');
const undiciFetchMock = vi.fn();

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

describe('/api/models/marketplace', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-stats-marketplace-'));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./stats.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(async () => {
    undiciFetchMock.mockReset();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns account-level discovered models even when account has no managed tokens', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-no-token',
      url: 'https://site-no-token.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'session-token',
      status: 'active',
      balance: 12.5,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'claude-sonnet-4-5-20250929',
      available: true,
      latencyMs: 233,
    }).run();

    const visibleRows = await db.select().from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();
    expect(visibleRows).toHaveLength(1);

    const response = await app.inject({
      method: 'GET',
      url: '/api/models/marketplace',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      models: Array<{
        name: string;
        accountCount: number;
        tokenCount: number;
        accounts: Array<{
          id: number;
          site: string;
          siteUrl: string | null;
          username: string | null;
          tokens: Array<{ id: number; name: string; isDefault: boolean }>;
        }>;
      }>;
    };
    const model = body.models.find((item) => item.name === 'claude-sonnet-4-5-20250929');
    expect(model).toBeDefined();
    expect(model?.accountCount).toBe(1);
    expect(model?.tokenCount).toBe(0);
    expect(model?.accounts).toHaveLength(1);
    expect(model?.accounts[0]).toMatchObject({
      id: account.id,
      site: 'site-no-token',
      siteUrl: 'https://site-no-token.example.com',
      username: 'alice',
      tokens: [],
    });
  });

  it('returns explicit hint when site has no usable key for model availability test', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-no-key',
      url: 'https://site-no-key.example.com',
      platform: 'new-api',
      status: 'active',
      apiKey: '',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'bob',
      accessToken: 'session-token',
      apiToken: '',
      status: 'active',
      balance: 1,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4o-mini',
      available: true,
      latencyMs: 120,
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'gpt-4o-mini',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      success: boolean;
      error: string;
      message: string;
      siteId: number;
    };
    expect(body.success).toBe(false);
    expect(body.error).toBe('site_missing_api_key');
    expect(body.message).toContain('请先创建 Key');
    expect(body.siteId).toBe(site.id);
  });

  it('marks model unavailable when probe returns HTTP 200 with embedded error', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-probe-error',
      url: 'https://site-probe-error.example.com',
      platform: 'one-api',
      status: 'active',
      apiKey: '',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'probe-error-user',
      accessToken: '',
      apiToken: 'sk-probe-error',
      status: 'active',
      balance: 1,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4o-mini',
      available: true,
      latencyMs: 120,
    }).run();

    undiciFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
        text: async () => JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ error: { message: 'No available channel for model gpt-4o-mini under group default' } }),
        text: async () => JSON.stringify({ error: { message: 'No available channel for model gpt-4o-mini under group default' } }),
      });

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'gpt-4o-mini',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      available: boolean;
      reason: string;
      probeStatusCode: number | null;
    };
    expect(body.success).toBe(true);
    expect(body.available).toBe(false);
    expect(body.probeStatusCode).toBe(200);
    expect(body.reason).toContain('probe rejected model via chat');
  });

  it('marks model unavailable when probe returns mismatched model in HTTP 200 response', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-model-mismatch',
      url: 'https://site-model-mismatch.example.com',
      platform: 'one-api',
      status: 'active',
      apiKey: '',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'mismatch-user',
      accessToken: '',
      apiToken: 'sk-model-mismatch',
      status: 'active',
      balance: 1,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4o-mini',
      available: true,
      latencyMs: 120,
    }).run();

    undiciFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
        text: async () => JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'resp_123', model: 'gpt-4o' }),
        text: async () => JSON.stringify({ id: 'resp_123', model: 'gpt-4o' }),
      });

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'gpt-4o-mini',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      available: boolean;
      reason: string;
      probeStatusCode: number | null;
    };
    expect(body.success).toBe(true);
    expect(body.available).toBe(false);
    expect(body.probeStatusCode).toBe(200);
    expect(body.reason).toContain('probe returned mismatched model via chat');
  });

  it('keeps model available when probe HTTP 200 response has matching model and no error', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-probe-ok',
      url: 'https://site-probe-ok.example.com',
      platform: 'one-api',
      status: 'active',
      apiKey: '',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'probe-ok-user',
      accessToken: '',
      apiToken: 'sk-probe-ok',
      status: 'active',
      balance: 1,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4o-mini',
      available: true,
      latencyMs: 120,
    }).run();

    undiciFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
        text: async () => JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'resp_456', model: 'gpt-4o-mini', choices: [{ message: { role: 'assistant', content: 'pong' } }] }),
        text: async () => JSON.stringify({ id: 'resp_456', model: 'gpt-4o-mini', choices: [{ message: { role: 'assistant', content: 'pong' } }] }),
      });

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'gpt-4o-mini',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      available: boolean;
      reason: string;
      probeStatusCode: number | null;
    };
    expect(body.success).toBe(true);
    expect(body.available).toBe(true);
    expect(body.probeStatusCode).toBe(200);
    expect(body.reason).toContain('model accepted by realtime probe');
  });

  it('uses embeddings probe for embedding models', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-embeddings',
      url: 'https://site-embeddings.example.com',
      platform: 'one-api',
      status: 'active',
      apiKey: '',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'embedding-user',
      accessToken: '',
      apiToken: 'sk-embedding',
      status: 'active',
      balance: 1,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'text-embedding-3-large',
      available: true,
      latencyMs: 80,
    }).run();

    undiciFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'text-embedding-3-large' }] }),
        text: async () => JSON.stringify({ data: [{ id: 'text-embedding-3-large' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          object: 'list',
          model: 'text-embedding-3-large',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
        }),
        text: async () => JSON.stringify({
          object: 'list',
          model: 'text-embedding-3-large',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
        }),
      });

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'text-embedding-3-large',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      available: boolean;
      probeCheckedUrl: string | null;
      reason: string;
    };
    expect(body.success).toBe(true);
    expect(body.available).toBe(true);
    expect(body.probeCheckedUrl).toBe('https://site-embeddings.example.com/v1/embeddings');
    expect(body.reason).toContain('probe succeeded via embeddings');
  });

  it('uses images probe for image models', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-images',
      url: 'https://site-images.example.com',
      platform: 'one-api',
      status: 'active',
      apiKey: '',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'image-user',
      accessToken: '',
      apiToken: 'sk-image',
      status: 'active',
      balance: 1,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-image-1',
      available: true,
      latencyMs: 90,
    }).run();

    undiciFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-image-1' }] }),
        text: async () => JSON.stringify({ data: [{ id: 'gpt-image-1' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          created: Date.now(),
          data: [{ b64_json: 'ZmFrZQ==' }],
        }),
        text: async () => JSON.stringify({
          created: Date.now(),
          data: [{ b64_json: 'ZmFrZQ==' }],
        }),
      });

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'gpt-image-1',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      available: boolean;
      probeCheckedUrl: string | null;
      reason: string;
    };
    expect(body.success).toBe(true);
    expect(body.available).toBe(true);
    expect(body.probeCheckedUrl).toBe('https://site-images.example.com/v1/images/generations');
    expect(body.reason).toContain('probe succeeded via images');
  });

  it('uses videos probe for video models', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-videos',
      url: 'https://site-videos.example.com',
      platform: 'one-api',
      status: 'active',
      apiKey: '',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'video-user',
      accessToken: '',
      apiToken: 'sk-video',
      status: 'active',
      balance: 1,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'sora_video2',
      available: true,
      latencyMs: 90,
    }).run();

    undiciFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'sora_video2' }] }),
        text: async () => JSON.stringify({ data: [{ id: 'sora_video2' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'vid_upstream_123',
          object: 'video',
          status: 'queued',
        }),
        text: async () => JSON.stringify({
          id: 'vid_upstream_123',
          object: 'video',
          status: 'queued',
        }),
      });

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'sora_video2',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      available: boolean;
      probeCheckedUrl: string | null;
      reason: string;
    };
    expect(body.success).toBe(true);
    expect(body.available).toBe(true);
    expect(body.probeCheckedUrl).toBe('https://site-videos.example.com/v1/videos');
    expect(body.reason).toContain('probe succeeded via videos');
  });

  it('uses gemini native embedding probe for official gemini sites', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-gemini',
      url: 'https://generativelanguage.googleapis.com',
      platform: 'gemini',
      status: 'active',
      apiKey: '',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'gemini-user',
      accessToken: '',
      apiToken: 'gemini-key',
      status: 'active',
      balance: 1,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'text-embedding-004',
      available: true,
      latencyMs: 50,
    }).run();

    undiciFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'models/text-embedding-004' }] }),
        text: async () => JSON.stringify({ models: [{ name: 'models/text-embedding-004' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          embedding: { values: [0.1, 0.2, 0.3] },
        }),
        text: async () => JSON.stringify({
          embedding: { values: [0.1, 0.2, 0.3] },
        }),
      });

    const response = await app.inject({
      method: 'POST',
      url: '/api/models/marketplace/test',
      payload: {
        modelName: 'text-embedding-004',
        accountId: account.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      available: boolean;
      probeCheckedUrl: string | null;
      reason: string;
    };
    expect(body.success).toBe(true);
    expect(body.available).toBe(true);
    expect(body.probeCheckedUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=gemini-key');
    expect(body.reason).toContain('probe succeeded via gemini.embedContent');
  });
});
