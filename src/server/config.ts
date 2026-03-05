import 'dotenv/config';

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export const config = {
  authToken: process.env.AUTH_TOKEN || 'change-me-admin-token',
  proxyToken: process.env.PROXY_TOKEN || 'change-me-proxy-sk-token',
  accountCredentialSecret: process.env.ACCOUNT_CREDENTIAL_SECRET || process.env.AUTH_TOKEN || 'change-me-admin-token',
  checkinCron: process.env.CHECKIN_CRON || '0 8 * * *',
  balanceRefreshCron: process.env.BALANCE_REFRESH_CRON || '0 * * * *',
  siteHealthRefreshCron: process.env.SITE_HEALTH_REFRESH_CRON || '*/15 * * * *',
  webhookUrl: process.env.WEBHOOK_URL || '',
  barkUrl: process.env.BARK_URL || '',
  webhookEnabled: parseBoolean(process.env.WEBHOOK_ENABLED, true),
  barkEnabled: parseBoolean(process.env.BARK_ENABLED, true),
  serverChanEnabled: parseBoolean(process.env.SERVERCHAN_ENABLED, true),
  serverChanKey: process.env.SERVERCHAN_KEY || '',
  telegramEnabled: parseBoolean(process.env.TELEGRAM_ENABLED, false),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  smtpEnabled: parseBoolean(process.env.SMTP_ENABLED, false),
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT || '587'),
  smtpSecure: parseBoolean(process.env.SMTP_SECURE, false),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || '',
  smtpTo: process.env.SMTP_TO || '',
  notifyCooldownSec: Math.max(0, Math.trunc(parseNumber(process.env.NOTIFY_COOLDOWN_SEC, 300))),
  adminIpAllowlist: parseCsvList(process.env.ADMIN_IP_ALLOWLIST),
  port: Math.trunc(parseNumber(process.env.PORT, 4000)),
  dataDir: process.env.DATA_DIR || './data',
  routingFallbackUnitCost: Math.max(1e-6, parseNumber(process.env.ROUTING_FALLBACK_UNIT_COST, 1)),
  tokenRouterCacheTtlMs: Math.max(100, Math.trunc(parseNumber(process.env.TOKEN_ROUTER_CACHE_TTL_MS, 1_500))),
  proxyLogRetentionDays: Math.max(0, Math.trunc(parseNumber(process.env.PROXY_LOG_RETENTION_DAYS, 30))),
  proxyLogRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(process.env.PROXY_LOG_RETENTION_PRUNE_INTERVAL_MINUTES, 30))),
  routingWeights: {
    baseWeightFactor: parseNumber(process.env.BASE_WEIGHT_FACTOR, 0.5),
    valueScoreFactor: parseNumber(process.env.VALUE_SCORE_FACTOR, 0.5),
    costWeight: parseNumber(process.env.COST_WEIGHT, 0.4),
    balanceWeight: parseNumber(process.env.BALANCE_WEIGHT, 0.3),
    usageWeight: parseNumber(process.env.USAGE_WEIGHT, 0.3),
  },
};
