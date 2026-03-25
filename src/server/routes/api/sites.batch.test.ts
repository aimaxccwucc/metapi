import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('sites batch routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-batch-'));
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
    await db.delete(schema.settings).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('enables system proxy for selected sites and reports failures', async () => {
    await db.insert(schema.sites).values([
      {
        id: 1,
        name: 'site-1',
        url: 'https://site-1.example.com',
        platform: 'new-api',
        useSystemProxy: false,
      },
      {
        id: 2,
        name: 'site-2',
        url: 'https://site-2.example.com',
        platform: 'new-api',
        useSystemProxy: false,
      },
    ]).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1, 2, 999],
        action: 'enableSystemProxy',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      successIds?: number[];
      failedItems?: Array<{ id: number; message: string }>;
    };
    expect(body.successIds).toEqual([1, 2]);
    expect(body.failedItems).toHaveLength(1);
    expect(body.failedItems?.[0]?.id).toBe(999);

    const rows = await db.select().from(schema.sites).all();
    expect(rows.every((row) => row.useSystemProxy === true)).toBe(true);
  });

  it('rejects invalid sites batch action', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1],
        action: 'nope',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('action');
  });

  it('removes manual protocol config when a site is batch deleted', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'delete-protocol-site',
        url: 'https://delete-protocol-site.example.com',
        platform: 'new-api',
        protocolConfig: {
          mode: 'manual',
          supportedEndpoints: ['responses'],
          preferredEndpoint: 'responses',
        },
      },
    });
    expect(created.statusCode).toBe(200);
    const site = created.json() as { id: number };

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [site.id],
        action: 'delete',
      },
    });

    expect(response.statusCode).toBe(200);
    const settingsRows = await db.select().from(schema.settings).all();
    expect(settingsRows.some((row) => row.key === 'site_protocol_config_v1')).toBe(true);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/sites',
    });
    expect(listResponse.statusCode).toBe(200);
    expect((listResponse.json() as Array<{ id: number }>).some((row) => row.id === site.id)).toBe(false);
  });
});
