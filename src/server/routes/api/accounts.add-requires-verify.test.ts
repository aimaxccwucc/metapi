import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const verifyTokenMock = vi.fn();
const getApiTokensMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts add requires token verification success', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-add-requires-verify-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(() => {
    verifyTokenMock.mockReset();
    getApiTokensMock.mockReset();
    getApiTokensMock.mockResolvedValue([]);

    db.delete(schema.proxyLogs).run();
    db.delete(schema.checkinLogs).run();
    db.delete(schema.routeChannels).run();
    db.delete(schema.tokenRoutes).run();
    db.delete(schema.tokenModelAvailability).run();
    db.delete(schema.modelAvailability).run();
    db.delete(schema.accountTokens).run();
    db.delete(schema.accounts).run();
    db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('rejects binding when token verification is not successful', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });

    const site = db.insert(schema.sites).values({
      name: 'Verify Site',
      url: 'https://verify.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'invalid-token',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
    });
    expect(db.select().from(schema.accounts).all()).toHaveLength(0);
  });

  it('returns rebind hint when token verify reports invalid access token', async () => {
    verifyTokenMock.mockRejectedValueOnce(new Error('无权进行此操作，access token 无效'));

    const site = db.insert(schema.sites).values({
      name: 'Verify Site',
      url: 'https://verify.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'invalid-token',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: '无权进行此操作，access token 无效，请在中转站重新生成系统访问令牌后重新绑定账号',
    });
    expect(db.select().from(schema.accounts).all()).toHaveLength(0);
  });

  it('allows binding when token verification succeeds as api key', async () => {
    verifyTokenMock.mockResolvedValueOnce({
      tokenType: 'apikey',
      models: ['gpt-4o-mini'],
    });

    const site = db.insert(schema.sites).values({
      name: 'API Key Site',
      url: 'https://apikey.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-valid-key',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { tokenType?: string; apiTokenFound?: boolean };
    expect(body.tokenType).toBe('apikey');
    expect(body.apiTokenFound).toBe(true);

    const accounts = db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect((accounts[0]?.apiToken || '').startsWith('sk-')).toBe(true);
  });

  it('allows saving unverified session only when explicitly requested', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });

    const site = db.insert(schema.sites).values({
      name: 'Shielded Site',
      url: 'https://shielded.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'session-token',
        credentialMode: 'session',
        allowUnverified: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { unverified?: boolean; queued?: boolean; initTaskId?: string };
    expect(body.unverified).toBe(true);
    expect(body.queued).toBe(false);
    expect(body.initTaskId).toBeUndefined();

    const accounts = db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.checkinEnabled).toBe(false);
    expect(accounts[0]?.accessToken).toBe('session-token');
  });
});
