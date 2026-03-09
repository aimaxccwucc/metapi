import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

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

  it('disables and re-enables related accounts in batch status updates', async () => {
    const site = await db.insert(schema.sites).values({
      id: 10,
      name: 'batch-status-site',
      url: 'https://batch-status.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'batch-user',
      accessToken: 'batch-access-token',
      status: 'active',
    }).returning().get();

    const disableResponse = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [site.id],
        action: 'disable',
      },
    });
    expect(disableResponse.statusCode).toBe(200);

    const disabledAccount = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(disabledAccount?.status).toBe('disabled');

    const enableResponse = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [site.id],
        action: 'enable',
      },
    });
    expect(enableResponse.statusCode).toBe(200);

    const enabledAccount = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(enabledAccount?.status).toBe('active');
  });
});
