import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import type { FastifyServerOptions } from 'fastify';
import { normalizePayloadRulesConfig } from './services/payloadRules.js';

const DEFAULT_REQUEST_BODY_LIMIT = 20 * 1024 * 1024;
const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_GEMINI_CLI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
export const MAX_PROXY_DEBUG_TRACE_ENTRIES = 5_000;
export const TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING = 30 * 24 * 60 * 60;

function createGeneratedToken(prefix: string): string {
  return `${prefix}${randomBytes(24).toString('base64url')}`;
}

function parseRequiredSecret(value: string | undefined, fallbackFactory: () => string): string {
  const normalized = (value || '').trim();
  return normalized || fallbackFactory();
}

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

function parseModelPatternList(value: string | undefined): string[] {
  return parseCsvList(value)
    .map((item) => item.trim())
    .filter((item, index, arr) => item.length > 0 && arr.indexOf(item) === index);
}

function parseOptionalSecret(value: string | undefined): string {
  return (value || '').trim();
}

function parseJsonValue(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseDbType(value: string | undefined): 'sqlite' | 'mysql' | 'postgres' {
  const normalized = (value || 'sqlite').trim().toLowerCase();
  if (normalized === 'mysql') return 'mysql';
  if (normalized === 'postgres' || normalized === 'postgresql') return 'postgres';
  return 'sqlite';
}

function parseListenHost(env: NodeJS.ProcessEnv): string {
  return (env.HOST || '0.0.0.0').trim() || '0.0.0.0';
}

export function buildConfig(env: NodeJS.ProcessEnv) {
  const dataDir = env.DATA_DIR || './data';
  const authToken = parseRequiredSecret(env.AUTH_TOKEN, () => createGeneratedToken('admin-'));
  const proxyToken = parseRequiredSecret(env.PROXY_TOKEN, () => createGeneratedToken('sk-'));
  const accountCredentialSecret = parseRequiredSecret(env.ACCOUNT_CREDENTIAL_SECRET, () => authToken);

  return {
    authToken,
    proxyToken,
    codexClientId: parseOptionalSecret(env.CODEX_CLIENT_ID) || DEFAULT_CODEX_CLIENT_ID,
    claudeClientId: parseOptionalSecret(env.CLAUDE_CLIENT_ID) || DEFAULT_CLAUDE_CLIENT_ID,
    claudeClientSecret: parseOptionalSecret(env.CLAUDE_CLIENT_SECRET),
    geminiCliClientId: parseOptionalSecret(env.GEMINI_CLI_CLIENT_ID) || DEFAULT_GEMINI_CLI_CLIENT_ID,
    geminiCliClientSecret: parseOptionalSecret(env.GEMINI_CLI_CLIENT_SECRET),
    systemProxyUrl: env.SYSTEM_PROXY_URL || '',
    flaresolverrUrl: env.FLARESOLVERR_URL || '',
    accountCredentialSecret,
    checkinCron: env.CHECKIN_CRON || '0 8 * * *',
    checkinScheduleMode: (env.CHECKIN_SCHEDULE_MODE || 'cron').trim().toLowerCase() === 'interval'
      ? 'interval' as const
      : 'cron' as const,
    checkinIntervalHours: Math.min(24, Math.max(1, Math.trunc(parseNumber(env.CHECKIN_INTERVAL_HOURS, 6)))),
    balanceRefreshCron: env.BALANCE_REFRESH_CRON || '0 * * * *',
    siteHealthRefreshCron: env.SITE_HEALTH_REFRESH_CRON || '*/15 * * * *',
    logCleanupCron: env.LOG_CLEANUP_CRON || '0 6 * * *',
    logCleanupConfigured: false,
    logCleanupUsageLogsEnabled: parseBoolean(env.LOG_CLEANUP_USAGE_LOGS_ENABLED, false),
    logCleanupProgramLogsEnabled: parseBoolean(env.LOG_CLEANUP_PROGRAM_LOGS_ENABLED, false),
    logCleanupRetentionDays: Math.max(1, Math.trunc(parseNumber(env.LOG_CLEANUP_RETENTION_DAYS, 30))),
    webhookUrl: env.WEBHOOK_URL || '',
    barkUrl: env.BARK_URL || '',
    webhookEnabled: parseBoolean(env.WEBHOOK_ENABLED, true),
    barkEnabled: parseBoolean(env.BARK_ENABLED, true),
    serverChanEnabled: parseBoolean(env.SERVERCHAN_ENABLED, true),
    serverChanKey: env.SERVERCHAN_KEY || '',
    telegramEnabled: parseBoolean(env.TELEGRAM_ENABLED, false),
    telegramApiBaseUrl: 'https://api.telegram.org',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',
    telegramUseSystemProxy: parseBoolean(env.TELEGRAM_USE_SYSTEM_PROXY, false),
    telegramMessageThreadId: (env.TELEGRAM_MESSAGE_THREAD_ID || '').trim(),
    smtpEnabled: parseBoolean(env.SMTP_ENABLED, false),
    smtpHost: env.SMTP_HOST || '',
    smtpPort: parseInt(env.SMTP_PORT || '587'),
    smtpSecure: parseBoolean(env.SMTP_SECURE, false),
    smtpUser: env.SMTP_USER || '',
    smtpPass: env.SMTP_PASS || '',
    smtpFrom: env.SMTP_FROM || '',
    smtpTo: env.SMTP_TO || '',
    notifyCooldownSec: Math.max(0, Math.trunc(parseNumber(env.NOTIFY_COOLDOWN_SEC, 300))),
    adminIpAllowlist: parseCsvList(env.ADMIN_IP_ALLOWLIST),
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    port: Math.trunc(parseNumber(env.PORT, 4000)),
    listenHost: parseListenHost(env),
    dataDir,
    dbType: parseDbType(env.DB_TYPE),
    dbUrl: (env.DB_URL || '').trim(),
    dbSsl: parseBoolean(env.DB_SSL, false),
    requestBodyLimit: DEFAULT_REQUEST_BODY_LIMIT,
    routingFallbackUnitCost: Math.max(1e-6, parseNumber(env.ROUTING_FALLBACK_UNIT_COST, 1)),
    disableCrossProtocolFallback: parseBoolean(env.DISABLE_CROSS_PROTOCOL_FALLBACK, false),
    globalAllowedModels: parseModelPatternList(env.GLOBAL_ALLOWED_MODELS),
    proxyDebugTraceEnabled: parseBoolean(env.PROXY_DEBUG_TRACE_ENABLED, false),
    proxyDebugTraceMaxEntries: Math.max(10, Math.min(MAX_PROXY_DEBUG_TRACE_ENTRIES, Math.trunc(parseNumber(env.PROXY_DEBUG_TRACE_MAX_ENTRIES, 300)))),
    tokenRouterCacheTtlMs: Math.max(100, Math.trunc(parseNumber(env.TOKEN_ROUTER_CACHE_TTL_MS, 1_500))),
    upstreamRequestTimeoutMs: Math.max(1_000, Math.trunc(parseNumber(env.UPSTREAM_REQUEST_TIMEOUT_MS, 20_000))),
    upstreamStreamFirstByteTimeoutMs: Math.max(1_000, Math.trunc(parseNumber(env.UPSTREAM_STREAM_FIRST_BYTE_TIMEOUT_MS, 45_000))),
    upstreamRequestBudgetMs: Math.max(1_000, Math.trunc(parseNumber(env.UPSTREAM_REQUEST_BUDGET_MS, 120_000))),
    upstreamStreamIdleTimeoutMs: Math.max(1_000, Math.trunc(parseNumber(env.UPSTREAM_STREAM_IDLE_TIMEOUT_MS, 180_000))),
    proxyFirstByteTimeoutSec: Math.max(0, Math.trunc(parseNumber(env.PROXY_FIRST_BYTE_TIMEOUT_SEC, 0))),
    proxyMaxChannelAttempts: Math.max(1, Math.trunc(parseNumber(env.PROXY_MAX_CHANNEL_ATTEMPTS, 3))),
    proxyStickySessionEnabled: parseBoolean(env.PROXY_STICKY_SESSION_ENABLED, true),
    proxyStickySessionTtlMs: Math.max(30_000, Math.trunc(parseNumber(env.PROXY_STICKY_SESSION_TTL_MS, 30 * 60 * 1000))),
    proxySessionChannelConcurrencyLimit: Math.max(0, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_CONCURRENCY_LIMIT, 2))),
    proxySessionChannelQueueWaitMs: Math.max(0, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_QUEUE_WAIT_MS, 1_500))),
    proxySessionChannelLeaseTtlMs: Math.max(5_000, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_LEASE_TTL_MS, 90_000))),
    proxySessionChannelLeaseKeepaliveMs: Math.max(1_000, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_LEASE_KEEPALIVE_MS, 15_000))),
    tokenRouterFailureCooldownMaxSec: Math.max(1, Math.min(30 * 24 * 60 * 60, Math.trunc(parseNumber(env.TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC, 30 * 24 * 60 * 60)))),
    proxyDebugCaptureHeaders: parseBoolean(env.PROXY_DEBUG_CAPTURE_HEADERS, true),
    proxyDebugCaptureBodies: parseBoolean(env.PROXY_DEBUG_CAPTURE_BODIES, false),
    proxyDebugCaptureStreamChunks: parseBoolean(env.PROXY_DEBUG_CAPTURE_STREAM_CHUNKS, false),
    onDemandModelRefreshCooldownMs: Math.max(0, Math.trunc(parseNumber(env.ON_DEMAND_MODEL_REFRESH_COOLDOWN_MS, 15_000))),
    autoRouteProbeThrottleMs: Math.max(60_000, Math.trunc(parseNumber(env.AUTO_ROUTE_PROBE_THROTTLE_MS, 30 * 60 * 1000))),
    routingAutoRecoveryRecheckMs: Math.max(5 * 60_000, Math.trunc(parseNumber(env.ROUTING_AUTO_RECOVERY_RECHECK_MS, 2 * 60 * 60 * 1000))),
    autoProbePrompt: parseOptionalSecret(env.AUTO_PROBE_PROMPT) || 'Reply exactly: OK',
    autoProbeMaxOutputTokens: Math.max(1, Math.min(8, Math.trunc(parseNumber(env.AUTO_PROBE_MAX_OUTPUT_TOKENS, 2)))),
    proxyMaxRetries: Math.max(0, Math.min(8, Math.trunc(parseNumber(env.PROXY_MAX_RETRIES, 4)))),
    downstreamAuthCacheTtlMs: Math.max(100, Math.trunc(parseNumber(env.DOWNSTREAM_AUTH_CACHE_TTL_MS, 15_000))),
    downstreamAuthNegativeCacheTtlMs: Math.max(100, Math.trunc(parseNumber(env.DOWNSTREAM_AUTH_NEGATIVE_CACHE_TTL_MS, 5_000))),
    responseCacheEnabled: parseBoolean(env.RESPONSE_CACHE_ENABLED, false),
    responseCacheTtlMs: Math.max(1_000, Math.trunc(parseNumber(env.RESPONSE_CACHE_TTL_MS, 60 * 60 * 1000))),
    responseCacheMaxRows: Math.max(100, Math.trunc(parseNumber(env.RESPONSE_CACHE_MAX_ROWS, 2_000))),
    responseCacheStaleIfErrorMs: Math.max(1_000, Math.trunc(parseNumber(env.RESPONSE_CACHE_STALE_IF_ERROR_MS, 10 * 60 * 1000))),
    responseCacheInflightTtlMs: Math.max(1_000, Math.trunc(parseNumber(env.RESPONSE_CACHE_INFLIGHT_TTL_MS, 30_000))),
    slowSuccessLatencyThresholdMs: Math.max(1_000, Math.trunc(parseNumber(env.SLOW_SUCCESS_LATENCY_THRESHOLD_MS, 15_000))),
    slowSuccessPenaltyScore: Math.max(0, parseNumber(env.SLOW_SUCCESS_PENALTY_SCORE, 0.25)),
    proxyLogRetentionDays: Math.max(0, Math.trunc(parseNumber(env.PROXY_LOG_RETENTION_DAYS, 30))),
    proxyLogRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(env.PROXY_LOG_RETENTION_PRUNE_INTERVAL_MINUTES, 30))),
    proxyFileRetentionDays: Math.max(0, Math.trunc(parseNumber(env.PROXY_FILE_RETENTION_DAYS, 30))),
    proxyFileRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(env.PROXY_FILE_RETENTION_PRUNE_INTERVAL_MINUTES, 60))),
    proxyErrorKeywords: parseCsvList(env.PROXY_ERROR_KEYWORDS),
    proxyEmptyContentFailEnabled: parseBoolean(env.PROXY_EMPTY_CONTENT_FAIL, true),
    channelAutoDisableOnConsecutiveFail: Math.max(2, Math.trunc(parseNumber(env.CHANNEL_AUTO_DISABLE_CONSECUTIVE_FAIL, 2))),
    codexResponsesWebsocketBeta: parseOptionalSecret(env.CODEX_RESPONSES_WEBSOCKET_BETA) || 'responses_websockets=2026-02-06',
    codexHeaderDefaults: {
      userAgent: parseOptionalSecret(env.CODEX_HEADER_DEFAULTS_USER_AGENT),
      betaFeatures: parseOptionalSecret(env.CODEX_HEADER_DEFAULTS_BETA_FEATURES),
    },
    payloadRules: normalizePayloadRulesConfig(parseJsonValue(env.PAYLOAD_RULES_JSON || env.PAYLOAD_RULES)),
    routingWeights: {
      baseWeightFactor: parseNumber(env.BASE_WEIGHT_FACTOR, 0.5),
      valueScoreFactor: parseNumber(env.VALUE_SCORE_FACTOR, 0.5),
      costWeight: parseNumber(env.COST_WEIGHT, 0.4),
      balanceWeight: parseNumber(env.BALANCE_WEIGHT, 0.3),
      usageWeight: parseNumber(env.USAGE_WEIGHT, 0.3),
    },
  };
}

export const config = buildConfig(process.env);

export function buildFastifyOptions(
  appConfig: ReturnType<typeof buildConfig>,
): FastifyServerOptions {
  return {
    logger: true,
    bodyLimit: appConfig.requestBodyLimit,
  };
}
