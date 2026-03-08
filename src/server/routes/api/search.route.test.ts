import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { mergeAccountExtraConfig } from '../../services/accountExtraConfig.js';

type DbModule = typeof import('../../db/index.js');

describe('search routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-search-route-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./search.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.searchRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns apikey connections and account tokens for global search', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'searchable key site',
      url: 'https://searchable-key.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: '',
      accessToken: '',
      apiToken: 'sk-searchable-key',
      status: 'active',
      extraConfig: mergeAccountExtraConfig(null, { credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'searchable token',
      token: 'sk-token-searchable',
      tokenGroup: 'searchable-group',
      enabled: true,
      isDefault: true,
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: {
        query: 'searchable',
        limit: 20,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accounts: [
        expect.objectContaining({
          id: account.id,
          segment: 'apikey',
          site: expect.objectContaining({
            name: 'searchable key site',
          }),
        }),
      ],
      accountTokens: [
        expect.objectContaining({
          name: 'searchable token',
          accountId: account.id,
          site: expect.objectContaining({
            name: 'searchable key site',
          }),
        }),
      ],
    });
  });

  it('finds apikey accounts by the API Key display label', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'plain site',
      url: 'https://plain.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: '',
      accessToken: '',
      apiToken: 'sk-only-key',
      status: 'active',
      extraConfig: mergeAccountExtraConfig(null, { credentialMode: 'apikey' }),
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: {
        query: 'API Key',
        limit: 20,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accounts: [
        expect.objectContaining({
          id: account.id,
          segment: 'apikey',
        }),
      ],
    });
  });
});
