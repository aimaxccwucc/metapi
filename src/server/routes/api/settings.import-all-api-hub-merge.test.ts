import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('settings import all-api-hub merge route', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-import-all-api-hub-merge-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const settingsRoutesModule = await import('./settings.js');
    const customRoutesModule = await import('../../custom/register.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
    await app.register(customRoutesModule.registerCustomRoutes);
  });

  beforeEach(() => {
    db.delete(schema.routeChannels).run();
    db.delete(schema.tokenRoutes).run();
    db.delete(schema.tokenModelAvailability).run();
    db.delete(schema.modelAvailability).run();
    db.delete(schema.proxyLogs).run();
    db.delete(schema.checkinLogs).run();
    db.delete(schema.accountTokens).run();
    db.delete(schema.accounts).run();
    db.delete(schema.sites).run();
    db.delete(schema.settings).run();
    db.delete(schema.events).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('rejects invalid payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/backup/import-all-api-hub-merge',
      payload: { data: null },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { success?: boolean; message?: string };
    expect(body.success).toBe(false);
    expect(body.message).toContain('JSON 对象');
  });

  it('imports accounts with merge mode', async () => {
    const payload = {
      timestamp: Date.now(),
      accounts: {
        accounts: [
          {
            site_url: 'https://merge.example.com',
            site_type: 'new-api',
            site_name: 'merge-site',
            authType: 'api_key',
            account_info: {
              id: 91001,
              username: 'merge-user',
              access_token: 'sk-merge-default',
              quota: 120000,
              today_quota_consumption: 20000,
            },
            apiTokens: [
              { key: 'sk-merge-default' },
              { key: 'sk-merge-extra' },
            ],
            checkIn: {
              autoCheckInEnabled: true,
            },
            created_at: '2031-01-01T00:00:00.000Z',
            updated_at: '2031-01-02T00:00:00.000Z',
          },
        ],
      },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/backup/import-all-api-hub-merge',
      payload: { data: payload },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      importedRows: number;
      sites?: { created?: number };
      accounts?: { created?: number };
      tokens?: { created?: number };
      repairedDefaultTokenAccounts?: number;
    };
    expect(body.success).toBe(true);
    expect(body.importedRows).toBe(1);
    expect(body.sites?.created).toBe(1);
    expect(body.accounts?.created).toBe(1);
    expect(body.tokens?.created).toBe(2);
    expect(body.repairedDefaultTokenAccounts).toBe(1);
  });
});
