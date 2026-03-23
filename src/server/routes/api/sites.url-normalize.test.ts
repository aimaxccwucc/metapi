import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

describe('sites url normalization', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-url-normalize-'));
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
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('stores only origin when creating a site from console url', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'aabb',
        url: 'https://new.aabb1.pro/console/personal',
        platform: 'new-api',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ url: 'https://new.aabb1.pro' });
  });
});
