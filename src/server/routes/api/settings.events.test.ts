import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');
type ConfigModule = typeof import('../../config.js');

describe('settings and auth events', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-events-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const settingsRoutesModule = await import('./settings.js');
    const authRoutesModule = await import('./auth.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
    await app.register(authRoutesModule.authRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();

    config.authToken = 'old-admin-token-123';
    config.proxyToken = 'sk-old-proxy-token-123';
    config.checkinCron = '0 8 * * *';
    config.balanceRefreshCron = '0 * * * *';
    config.routingFallbackUnitCost = 1;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('appends event when runtime settings are updated', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        proxyToken: 'sk-new-proxy-token-456',
        checkinCron: '5 9 * * *',
      },
    });

    expect(response.statusCode).toBe(200);

    const events = await db.select().from(schema.events).all();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: 'status',
      title: '运行时设置已更新',
      relatedType: 'settings',
    });
    expect(events[0].message || '').toContain('代理访问 Token');
    expect(events[0].message || '').toContain('签到 Cron');
  });

  it('returns current recognized admin IP in runtime settings response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/settings/runtime',
      remoteAddress: '10.0.0.8',
      headers: {
        'x-forwarded-for': '203.0.113.5, 10.0.0.8',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { currentAdminIp?: string };
    expect(body.currentAdminIp).toBe('203.0.113.5');
  });

  it('rejects proxy token that does not start with sk-', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        proxyToken: 'new-proxy-token-456',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { message?: string };
    expect(body.message).toContain('sk-');
  });

  it('rejects invalid bark url when bark channel is enabled', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        barkEnabled: true,
        barkUrl: 'juricek.chen@gmail.com',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { message?: string };
    expect(body.message).toContain('Bark URL');
  });

  it('rejects invalid webhook url when webhook channel is enabled', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        webhookEnabled: true,
        webhookUrl: 'not-a-url',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { message?: string };
    expect(body.message).toContain('Webhook URL');
  });

  it('rejects telegram config when bot token is missing but telegram is enabled', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        telegramEnabled: true,
        telegramChatId: '-1001234567890',
        telegramBotToken: '',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { message?: string };
    expect(body.message).toContain('Telegram Bot Token');
  });

  it('rejects telegram config when chat id is missing but telegram is enabled', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        telegramEnabled: true,
        telegramBotToken: '123456:telegram-token',
        telegramChatId: '',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { message?: string };
    expect(body.message).toContain('Telegram Chat ID');
  });

  it('persists and returns routing fallback unit cost from runtime settings', async () => {
    const updateResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        routingFallbackUnitCost: 0.25,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as { routingFallbackUnitCost?: number };
    expect(updated.routingFallbackUnitCost).toBe(0.25);
    expect(config.routingFallbackUnitCost).toBe(0.25);

    const saved = await db.select().from(schema.settings).where(eq(schema.settings.key, 'routing_fallback_unit_cost')).get();
    expect(saved).toBeTruthy();
    expect(saved?.value).toBe(JSON.stringify(0.25));

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/settings/runtime',
    });
    expect(getResponse.statusCode).toBe(200);
    const runtime = getResponse.json() as { routingFallbackUnitCost?: number };
    expect(runtime.routingFallbackUnitCost).toBe(0.25);
  });

  it('rejects allowlist update that does not include current request IP', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      remoteAddress: '198.51.100.10',
      payload: {
        adminIpAllowlist: ['198.51.100.11'],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { message?: string };
    expect(body.message).toContain('白名单');
    expect(body.message).toContain('198.51.100.10');

    const saved = await db.select().from(schema.settings).where(eq(schema.settings.key, 'admin_ip_allowlist')).get();
    expect(saved).toBeFalsy();
  });

  it('allows allowlist update when current request IP is included', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      remoteAddress: '198.51.100.10',
      payload: {
        adminIpAllowlist: ['198.51.100.10', '198.51.100.11'],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { adminIpAllowlist?: string[] };
    expect(body.adminIpAllowlist).toEqual(['198.51.100.10', '198.51.100.11']);

    const saved = await db.select().from(schema.settings).where(eq(schema.settings.key, 'admin_ip_allowlist')).get();
    expect(saved?.value).toBe(JSON.stringify(['198.51.100.10', '198.51.100.11']));
  });

  it('appends event when admin auth token changes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/change',
      payload: {
        oldToken: 'old-admin-token-123',
        newToken: 'new-admin-token-456',
      },
    });

    expect(response.statusCode).toBe(200);

    const events = await db.select().from(schema.events).all();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: 'token',
      title: '管理员登录令牌已更新',
      relatedType: 'settings',
    });
  });
});
