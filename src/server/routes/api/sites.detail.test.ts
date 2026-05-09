import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

describe('sites detail API', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-detail-'));
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
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('aggregates site accounts, tokens, models and groups without exposing raw token values', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'detail-site',
      url: 'https://detail.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'account-a',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'vip-key',
      token: 'sk-site-detail-secret',
      tokenGroup: 'vip',
      valueStatus: 'ready',
      enabled: true,
      isDefault: true,
      source: 'manual',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      { accountId: account.id, modelName: 'gpt-4o', available: true },
      { accountId: account.id, modelName: 'gpt-disabled', available: false },
    ]).run();
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-4o-mini',
      available: true,
    }).run();

    const resp = await app.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/detail`,
    });

    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.summary).toMatchObject({
      accountCount: 1,
      tokenCount: 1,
      modelCount: 2,
      groupCount: 2,
    });
    expect(JSON.stringify(body)).not.toContain('sk-site-detail-secret');
    expect(body.tokens[0]).toMatchObject({
      id: token.id,
      accountId: account.id,
      accountName: 'account-a',
      name: 'vip-key',
      group: 'vip',
      enabled: true,
      isDefault: true,
      modelCount: 1,
      models: ['gpt-4o-mini'],
    });
    expect(body.tokens[0].tokenMasked).toContain('***');

    const modelNames = body.models.map((item: any) => item.name);
    expect(modelNames).toContain('gpt-4o');
    expect(modelNames).toContain('gpt-4o-mini');

    const vipGroup = body.groups.find((item: any) => item.group === 'vip');
    expect(vipGroup).toBeTruthy();
    expect(vipGroup.models).toEqual(['gpt-4o-mini']);

    const defaultGroup = body.groups.find((item: any) => item.group === 'default');
    expect(defaultGroup).toBeTruthy();
    expect(defaultGroup.models).toEqual(['gpt-4o']);
  });
});
