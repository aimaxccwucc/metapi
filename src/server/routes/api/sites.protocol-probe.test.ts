import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { probeSiteProtocolMock } = vi.hoisted(() => ({
  probeSiteProtocolMock: vi.fn(),
}));

vi.mock('../../services/siteProtocolProbeService.js', () => ({
  probeSiteProtocol: (...args: unknown[]) => probeSiteProtocolMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('sites protocol probe routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-protocol-probe-route-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    probeSiteProtocolMock.mockReset();
    await db.delete(schema.settings).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('probes a site protocol and persists the detected config', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'route-site',
      url: 'https://route-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    probeSiteProtocolMock.mockResolvedValue({
      siteId: site.id,
      siteName: site.name,
      sitePlatform: site.platform,
      modelName: 'gpt-4.1',
      accountId: 11,
      accountName: 'alice',
      credentialSource: 'account_api_token',
      supportedEndpoints: ['responses'],
      preferredEndpoint: 'responses',
      attempts: [
        {
          endpoint: 'chat',
          checkedUrl: 'https://route-site.example.com/v1/chat/completions',
          statusCode: 400,
          ok: false,
          classification: 'protocol_mismatch',
          reason: 'Unsupported legacy protocol',
        },
        {
          endpoint: 'responses',
          checkedUrl: 'https://route-site.example.com/v1/responses',
          statusCode: 200,
          ok: true,
          classification: 'supported',
          reason: 'ok',
        },
      ],
      attemptSummary: [
        '1. chat protocol_mismatch: Unsupported legacy protocol',
        '2. responses success: ok',
      ],
      latencyMs: 123,
      probeSource: 'live',
      cacheHit: false,
      cachedAtMs: null,
      cooldownUntilMs: null,
      cooldownRemainingMs: 0,
      protocolConfig: {
        mode: 'manual',
        supportedEndpoints: ['responses', 'chat', 'messages'],
        preferredEndpoint: 'responses',
        updatedAtMs: Date.now(),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/protocol-probe`,
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      success?: boolean;
      modelName?: string;
      preferredEndpoint?: string;
      attemptSummary?: string[];
      probeSource?: string;
      protocolConfig?: { mode?: string; supportedEndpoints?: string[]; preferredEndpoint?: string | null };
    };
    expect(payload.success).toBe(true);
    expect(payload.modelName).toBe('gpt-4.1');
    expect(payload.preferredEndpoint).toBe('responses');
    expect(payload.probeSource).toBe('live');
    expect(payload.attemptSummary).toHaveLength(2);
    expect(payload.protocolConfig).toEqual({
      mode: 'manual',
      supportedEndpoints: ['responses', 'chat', 'messages'],
      preferredEndpoint: 'responses',
      updatedAtMs: expect.any(Number),
    });

    const settingsRows = await db.select().from(schema.settings).all();
    expect(settingsRows.some((row) => row.key === 'site_protocol_config_v1')).toBe(true);
  });
});
