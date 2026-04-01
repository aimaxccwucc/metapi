import { type FastifyInstance } from 'fastify';
import { sql, eq, and, gte } from 'drizzle-orm';
import { db, runtimeDbDialect, schema } from '../db/index.js';
import { config } from '../config.js';
import { getOAuthLoopbackCallbackServerStates } from '../services/oauth/localCallbackServer.js';
import { listBackgroundTasks } from '../services/backgroundTaskService.js';
import { getResponseCacheRuntimeStatus, isResponseCacheAvailable } from '../services/responseCacheService.js';

type RuntimeStatusRouteOptions = {
  startedAt: Date;
};

type RuntimeOverviewResponse = {
  service: {
    name: string;
    version: string;
    uptimeSec: number;
    startedAt: string;
    now: string;
    environment: {
      port: number;
      host: string;
      dbDialect: string;
      dataDir: string;
    };
  };
  database: {
    ready: boolean;
    dialect: string;
  };
  responseCache: ReturnType<typeof getResponseCacheRuntimeStatus>;
  oauthLoopback: {
    total: number;
    ready: number;
    attempted: number;
    states: ReturnType<typeof getOAuthLoopbackCallbackServerStates>;
  };
  backgroundTasks: {
    total: number;
    pending: number;
    running: number;
    failed: number;
  };
  notifications: {
    webhookEnabled: boolean;
    barkEnabled: boolean;
    telegramEnabled: boolean;
    serverChanEnabled: boolean;
    smtpEnabled: boolean;
    cooldownSec: number;
  };
  recentActivity: {
    proxyRequests24h: number;
    proxyFailures24h: number;
    unreadEvents: number;
  };
};

async function checkDatabaseReady(): Promise<boolean> {
  try {
    await db.select({ value: sql<number>`1` }).from(schema.settings).limit(1).all();
    return true;
  } catch {
    return false;
  }
}

function buildTaskSummary() {
  const tasks = listBackgroundTasks(200);
  return tasks.reduce((summary, task) => {
    summary.total += 1;
    if (task.status === 'pending') summary.pending += 1;
    if (task.status === 'running') summary.running += 1;
    if (task.status === 'failed') summary.failed += 1;
    return summary;
  }, {
    total: 0,
    pending: 0,
    running: 0,
    failed: 0,
  });
}

async function buildRecentActivity() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const [proxyRow, unreadEventsRow] = await Promise.all([
      db.select({
        total: sql<number>`count(*)`,
        failed: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'failed' then 1 else 0 end), 0)`,
      })
        .from(schema.proxyLogs)
        .where(gte(schema.proxyLogs.createdAt, since24h))
        .get(),
      db.select({
        unread: sql<number>`count(*)`,
      })
        .from(schema.events)
        .where(and(
          eq(schema.events.read, false),
          eq(schema.events.type, 'status'),
        ))
        .get(),
    ]);

    return {
      proxyRequests24h: Number(proxyRow?.total || 0),
      proxyFailures24h: Number(proxyRow?.failed || 0),
      unreadEvents: Number(unreadEventsRow?.unread || 0),
    };
  } catch {
    return {
      proxyRequests24h: 0,
      proxyFailures24h: 0,
      unreadEvents: 0,
    };
  }
}

async function buildRuntimeOverview(startedAt: Date): Promise<RuntimeOverviewResponse> {
  await isResponseCacheAvailable();
  const [databaseReady, recentActivity] = await Promise.all([
    checkDatabaseReady(),
    buildRecentActivity(),
  ]);
  const responseCache = getResponseCacheRuntimeStatus();
  const oauthStates = getOAuthLoopbackCallbackServerStates();
  const readyOauthCount = oauthStates.filter((state) => state.ready).length;
  const attemptedOauthCount = oauthStates.filter((state) => state.attempted).length;
  const now = new Date();

  return {
    service: {
      name: 'metapi',
      version: '1.2.3',
      uptimeSec: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)),
      startedAt: startedAt.toISOString(),
      now: now.toISOString(),
      environment: {
        port: config.port,
        host: config.listenHost,
        dbDialect: runtimeDbDialect,
        dataDir: config.dataDir,
      },
    },
    database: {
      ready: databaseReady,
      dialect: runtimeDbDialect,
    },
    responseCache,
    oauthLoopback: {
      total: oauthStates.length,
      ready: readyOauthCount,
      attempted: attemptedOauthCount,
      states: oauthStates,
    },
    backgroundTasks: buildTaskSummary(),
    notifications: {
      webhookEnabled: !!config.webhookEnabled,
      barkEnabled: !!config.barkEnabled,
      telegramEnabled: !!config.telegramEnabled,
      serverChanEnabled: !!config.serverChanEnabled,
      smtpEnabled: !!config.smtpEnabled,
      cooldownSec: Math.max(0, Math.trunc(config.notifyCooldownSec || 0)),
    },
    recentActivity,
  };
}

function buildMetricsPayload(overview: RuntimeOverviewResponse): string {
  const lines = [
    '# HELP metapi_up Process is running.',
    '# TYPE metapi_up gauge',
    'metapi_up 1',
    '# HELP metapi_ready Service readiness state.',
    '# TYPE metapi_ready gauge',
    `metapi_ready ${overview.database.ready ? 1 : 0}`,
    '# HELP metapi_uptime_seconds Service uptime in seconds.',
    '# HELP metapi_response_cache_ready Response cache readiness state.',
    '# TYPE metapi_response_cache_ready gauge',
    `metapi_response_cache_ready ${overview.responseCache.ready ? 1 : 0}`,
    '# HELP metapi_response_cache_failures_total Response cache failures by operation.',
    '# TYPE metapi_response_cache_failures_total gauge',
    `metapi_response_cache_failures_total{kind="read"} ${overview.responseCache.readFailures}`,
    `metapi_response_cache_failures_total{kind="write"} ${overview.responseCache.writeFailures}`,
    `metapi_response_cache_failures_total{kind="prune"} ${overview.responseCache.pruneFailures}`,
    '# HELP metapi_response_cache_hits_total Response cache hits by kind.',
    '# TYPE metapi_response_cache_hits_total gauge',
    `metapi_response_cache_hits_total{kind="hit"} ${overview.responseCache.hits}`,
    `metapi_response_cache_hits_total{kind="stale"} ${overview.responseCache.staleHits}`,
    `metapi_response_cache_hits_total{kind="miss"} ${overview.responseCache.misses}`,
    '# HELP metapi_response_cache_saved_tokens_total Response cache saved tokens.',
    '# TYPE metapi_response_cache_saved_tokens_total gauge',
    `metapi_response_cache_saved_tokens_total ${overview.responseCache.savedTokens}`,
    '# HELP metapi_response_cache_saved_cost_total Response cache saved cost.',
    '# TYPE metapi_response_cache_saved_cost_total gauge',
    `metapi_response_cache_saved_cost_total ${overview.responseCache.savedCost}`,
    '# HELP metapi_response_cache_prune_deleted_total Response cache deleted rows during prune by reason.',
    '# TYPE metapi_response_cache_prune_deleted_total gauge',
    `metapi_response_cache_prune_deleted_total{reason="expired"} ${overview.responseCache.pruneDeletedExpiredRows}`,
    `metapi_response_cache_prune_deleted_total{reason="overflow"} ${overview.responseCache.pruneDeletedOverflowRows}`,
    '# TYPE metapi_uptime_seconds gauge',
    `metapi_uptime_seconds ${overview.service.uptimeSec}`,
    '# HELP metapi_background_tasks Number of in-memory background tasks by status.',
    '# TYPE metapi_background_tasks gauge',
    `metapi_background_tasks{status="total"} ${overview.backgroundTasks.total}`,
    `metapi_background_tasks{status="pending"} ${overview.backgroundTasks.pending}`,
    `metapi_background_tasks{status="running"} ${overview.backgroundTasks.running}`,
    `metapi_background_tasks{status="failed"} ${overview.backgroundTasks.failed}`,
    '# HELP metapi_oauth_loopback_servers OAuth loopback listener states.',
    '# TYPE metapi_oauth_loopback_servers gauge',
    `metapi_oauth_loopback_servers{state="total"} ${overview.oauthLoopback.total}`,
    `metapi_oauth_loopback_servers{state="ready"} ${overview.oauthLoopback.ready}`,
    `metapi_oauth_loopback_servers{state="attempted"} ${overview.oauthLoopback.attempted}`,
    '# HELP metapi_proxy_requests_total Proxy request count in the last 24 hours.',
    '# TYPE metapi_proxy_requests_total gauge',
    `metapi_proxy_requests_total ${overview.recentActivity.proxyRequests24h}`,
    '# HELP metapi_proxy_failures_total Proxy failure count in the last 24 hours.',
    '# TYPE metapi_proxy_failures_total gauge',
    `metapi_proxy_failures_total ${overview.recentActivity.proxyFailures24h}`,
    '# HELP metapi_unread_status_events Unread status events.',
    '# TYPE metapi_unread_status_events gauge',
    `metapi_unread_status_events ${overview.recentActivity.unreadEvents}`,
  ];
  return `${lines.join('\n')}\n`;
}

export async function systemRoutes(app: FastifyInstance, options: RuntimeStatusRouteOptions) {
  app.get('/healthz', async () => ({
    ok: true,
    service: 'metapi',
    version: '1.2.3',
    uptimeSec: Math.max(0, Math.floor((Date.now() - options.startedAt.getTime()) / 1000)),
  }));

  app.get('/readyz', async (request, reply) => {
    const overview = await buildRuntimeOverview(options.startedAt);
    const ready = overview.database.ready;
    if (!ready) {
      reply.code(503);
    }
    return {
      ok: ready,
      database: overview.database,
      responseCache: {
        ready: overview.responseCache.ready,
        availabilityChecked: overview.responseCache.availabilityChecked,
        lastError: overview.responseCache.lastError,
      },
      oauthLoopback: {
        ready: overview.oauthLoopback.ready,
        total: overview.oauthLoopback.total,
      },
      backgroundTasks: overview.backgroundTasks,
    };
  });

  app.get('/metrics', async (_request, reply) => {
    const overview = await buildRuntimeOverview(options.startedAt);
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return buildMetricsPayload(overview);
  });

  app.get('/api/system/runtime-overview', async () => {
    return await buildRuntimeOverview(options.startedAt);
  });
}
