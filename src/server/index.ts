import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { sitesRoutes } from './routes/api/sites.js';
import { accountsRoutes } from './routes/api/accounts.js';
import { checkinRoutes } from './routes/api/checkin.js';
import { tokensRoutes } from './routes/api/tokens.js';
import { statsRoutes } from './routes/api/stats.js';
import { authRoutes } from './routes/api/auth.js';
import { settingsRoutes } from './routes/api/settings.js';
import { accountTokensRoutes } from './routes/api/accountTokens.js';
import { searchRoutes } from './routes/api/search.js';
import { eventsRoutes } from './routes/api/events.js';
import { taskRoutes } from './routes/api/tasks.js';
import { testRoutes } from './routes/api/test.js';
import { monitorRoutes } from './routes/api/monitor.js';
import { downstreamApiKeysRoutes } from './routes/api/downstreamApiKeys.js';
import { proxyRoutes } from './routes/proxy/router.js';
import { startScheduler } from './services/checkinScheduler.js';
import { startProxyLogRetentionService, stopProxyLogRetentionService } from './services/proxyLogRetentionService.js';
import { buildStartupSummaryLines } from './services/startupInfo.js';
import { existsSync } from 'fs';
import { normalize, resolve, sep } from 'path';
import { db, schema } from './db/index.js';

// Load runtime config overrides from settings
try {
  const rows = db.select().from(schema.settings).all();
  const settingsMap = new Map(rows.map((row) => [row.key, row.value]));

  const parseSetting = <T>(key: string): T | undefined => {
    const raw = settingsMap.get(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  };

  const toStringList = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0);
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    return [];
  };

  const authToken = parseSetting<string>('auth_token');
  if (typeof authToken === 'string' && authToken) config.authToken = authToken;

  const proxyToken = parseSetting<string>('proxy_token');
  if (typeof proxyToken === 'string' && proxyToken) config.proxyToken = proxyToken;

  const checkinCron = parseSetting<string>('checkin_cron');
  if (typeof checkinCron === 'string' && checkinCron) config.checkinCron = checkinCron;

  const balanceRefreshCron = parseSetting<string>('balance_refresh_cron');
  if (typeof balanceRefreshCron === 'string' && balanceRefreshCron) config.balanceRefreshCron = balanceRefreshCron;

  const siteHealthRefreshCron = parseSetting<string>('site_health_refresh_cron');
  if (typeof siteHealthRefreshCron === 'string' && siteHealthRefreshCron) {
    config.siteHealthRefreshCron = siteHealthRefreshCron;
  }

  const routingWeights = parseSetting<Partial<typeof config.routingWeights>>('routing_weights');
  if (routingWeights && typeof routingWeights === 'object') {
    config.routingWeights = {
      ...config.routingWeights,
      ...routingWeights,
    };
  }

  const routingFallbackUnitCost = parseSetting<number>('routing_fallback_unit_cost');
  if (typeof routingFallbackUnitCost === 'number' && Number.isFinite(routingFallbackUnitCost) && routingFallbackUnitCost > 0) {
    config.routingFallbackUnitCost = Math.max(1e-6, routingFallbackUnitCost);
  }

  const webhookUrl = parseSetting<string>('webhook_url');
  if (typeof webhookUrl === 'string') config.webhookUrl = webhookUrl;

  const barkUrl = parseSetting<string>('bark_url');
  if (typeof barkUrl === 'string') config.barkUrl = barkUrl;

  const serverChanKey = parseSetting<string>('serverchan_key');
  if (typeof serverChanKey === 'string') config.serverChanKey = serverChanKey;

  const telegramEnabled = parseSetting<boolean>('telegram_enabled');
  if (typeof telegramEnabled === 'boolean') config.telegramEnabled = telegramEnabled;

  const telegramBotToken = parseSetting<string>('telegram_bot_token');
  if (typeof telegramBotToken === 'string') config.telegramBotToken = telegramBotToken;

  const telegramChatId = parseSetting<string>('telegram_chat_id');
  if (typeof telegramChatId === 'string') config.telegramChatId = telegramChatId;

  const smtpEnabled = parseSetting<boolean>('smtp_enabled');
  if (typeof smtpEnabled === 'boolean') config.smtpEnabled = smtpEnabled;

  const smtpHost = parseSetting<string>('smtp_host');
  if (typeof smtpHost === 'string') config.smtpHost = smtpHost;

  const smtpPort = parseSetting<number>('smtp_port');
  if (typeof smtpPort === 'number' && Number.isFinite(smtpPort) && smtpPort > 0) {
    config.smtpPort = smtpPort;
  }

  const smtpSecure = parseSetting<boolean>('smtp_secure');
  if (typeof smtpSecure === 'boolean') config.smtpSecure = smtpSecure;

  const smtpUser = parseSetting<string>('smtp_user');
  if (typeof smtpUser === 'string') config.smtpUser = smtpUser;

  const smtpPass = parseSetting<string>('smtp_pass');
  if (typeof smtpPass === 'string') config.smtpPass = smtpPass;

  const smtpFrom = parseSetting<string>('smtp_from');
  if (typeof smtpFrom === 'string') config.smtpFrom = smtpFrom;

  const smtpTo = parseSetting<string>('smtp_to');
  if (typeof smtpTo === 'string') config.smtpTo = smtpTo;

  const notifyCooldownSec = parseSetting<number>('notify_cooldown_sec');
  if (typeof notifyCooldownSec === 'number' && Number.isFinite(notifyCooldownSec) && notifyCooldownSec >= 0) {
    config.notifyCooldownSec = Math.trunc(notifyCooldownSec);
  }

  const adminIpAllowlist = parseSetting<string[] | string>('admin_ip_allowlist');
  if (adminIpAllowlist !== undefined) {
    config.adminIpAllowlist = toStringList(adminIpAllowlist);
  }

  console.log('Loaded runtime settings overrides');
} catch { /* first run, table may not exist */ }

const app = Fastify({ logger: true });

await app.register(cors);

// Be tolerant of empty JSON bodies and missing content-type on internal admin APIs.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
  const raw = typeof body === 'string' ? body.trim() : '';
  if (!raw) {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(raw));
  } catch (error) {
    done(error as Error, undefined);
  }
});

app.addHook('onRequest', async (request) => {
  const method = request.method.toUpperCase();
  if (!(method === 'POST' || method === 'PUT' || method === 'PATCH')) return;
  if (!request.url.startsWith('/api/')) return;

  const headers = request.headers as Record<string, unknown>;
  const hasContentType = typeof headers['content-type'] === 'string' && headers['content-type'].trim().length > 0;
  if (!hasContentType) {
    headers['content-type'] = 'application/json';
  }
});

// Auth middleware for /api routes
app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/api/')) {
    await authMiddleware(request, reply);
  }
});

// Register API routes
await app.register(sitesRoutes);
await app.register(accountsRoutes);
await app.register(checkinRoutes);
await app.register(tokensRoutes);
await app.register(statsRoutes);
await app.register(authRoutes);
await app.register(settingsRoutes);
await app.register(accountTokensRoutes);
await app.register(searchRoutes);
await app.register(eventsRoutes);
await app.register(taskRoutes);
await app.register(testRoutes);
await app.register(monitorRoutes);
await app.register(downstreamApiKeysRoutes);

// Register OpenAI-compatible proxy routes
await app.register(proxyRoutes);

// Serve static web frontend in production
const webDir = resolve('dist/web');
if (existsSync(webDir)) {
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
    wildcard: false,
    setHeaders: (res, filePath) => {
      const normalizedPath = normalize(filePath);
      if (normalizedPath.includes(`${sep}assets${sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return;
      }
      if (normalizedPath.endsWith(`${sep}index.html`)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });
  // SPA fallback
  app.setNotFoundHandler(async (request, reply) => {
    if (!request.url.startsWith('/api/') && !request.url.startsWith('/v1/')) {
      return reply.sendFile('index.html');
    }
    reply.code(404).send({ error: 'Not found' });
  });
}

// Start scheduler
startScheduler();
startProxyLogRetentionService();
app.addHook('onClose', async () => {
  stopProxyLogRetentionService();
});

// Start server
try {
  const listenHost = '0.0.0.0';
  await app.listen({ port: config.port, host: listenHost });
  const summaryLines = buildStartupSummaryLines({
    port: config.port,
    host: listenHost,
    authToken: config.authToken,
    proxyToken: config.proxyToken,
  });
  for (const line of summaryLines) {
    console.log(line);
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
