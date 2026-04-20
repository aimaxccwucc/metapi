/**
 * routeProbeService — route channel probing & auto-governance
 *
 * Extracted from tokens.ts so that alertService (and future callers) can
 * trigger route probes without going through a Fastify request.
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  probeMarketplaceModelAvailability,
  type MarketplaceProbeClassification,
} from './marketplaceModelProbeService.js';
import {
  upsertRoutingGovernanceState,
  clearRoutingGovernanceStates,
  type RoutingGovernanceReasonCode,
} from './routingGovernanceService.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';

// ── types (mirror the shapes used by the API) ────────────────────────

export type RouteProbeItem = {
  channelId: number;
  accountId: number;
  accountName: string | null;
  siteId: number;
  siteName: string;
  tokenId: number | null;
  tokenName: string | null;
  sourceModel: string | null;
  available: boolean;
  inconclusive?: boolean;
  reason: string;
  probeClassification: MarketplaceProbeClassification | null;
  probeEndpoint: string | null;
  latencyMs: number | null;
  detectionMethod: 'model_list' | 'realtime_probe' | 'unknown' | 'probe_failed';
  governanceAction: 'suppressed' | 'cleared' | 'none';
  governanceReasonCode: string | null;
  autoKeyCreated?: boolean;
  autoKeyName?: string | null;
};

export type RouteProbeResponse = {
  success: true;
  routeId: number;
  routeModelPattern: string;
  probedModel: string;
  autoGovernance: boolean;
  total: number;
  availableCount: number;
  unavailableCount: number;
  skippedCount: number;
  inconclusiveCount: number;
  failedCount: number;
  items: RouteProbeItem[];
};

// ── helpers ──────────────────────────────────────────────────────────

const ROUTE_PROBE_CONCURRENCY = 6;
const MANUAL_ROUTE_PROBE_MARKER = '[manual_route_probe]';

function nowPlusMs(ms: number): string {
  return new Date(Date.now() + Math.max(0, ms)).toISOString();
}

function resolveRouteProbeLimit(rawLimit: unknown): number {
  if (rawLimit === undefined || rawLimit === null || rawLimit === '') return 50;
  const parsed = Number.parseInt(String(rawLimit), 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(200, parsed));
}

function mapProbeClassificationToGovernanceReason(
  classification: MarketplaceProbeClassification | null,
): RoutingGovernanceReasonCode | null {
  if (classification === 'model_unavailable') return 'model_unsupported';
  if (classification === 'credential') return 'auth';
  if (classification === 'inconclusive') return 'invalid_channel';
  return null;
}

function classifyProbeClassificationFromError(errorText: string): MarketplaceProbeClassification | null {
  const text = String(errorText || '').toLowerCase();
  if (!text) return null;
  if (/site_missing_api_key|api key|token|unauthorized|forbidden|鉴权|未授权/.test(text)) return 'credential';
  if (/model.*(not found|unsupported|invalid)|模型.*(不存在|不支持|不可用)/.test(text)) return 'model_unavailable';
  if (/\/v1\/responses|\/v1\/messages|generatecontent|x-goog-api-key/.test(text)) return 'protocol_mismatch';
  return 'inconclusive';
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const normalizedConcurrency = Math.max(1, Math.min(items.length || 1, Math.trunc(concurrency) || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;

  await Promise.all(Array.from({ length: normalizedConcurrency }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }));

  return results;
}

// ── governance ───────────────────────────────────────────────────────

type RouteChannelLike = {
  id: number;
  accountId: number;
  tokenId: number | null;
  enabled: boolean | null;
  sourceModel: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  account: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  site: any;
  token: { id: number; name?: string | null; [k: string]: unknown } | null;
};

type RouteLike = {
  id: number;
  modelPattern: string;
  probePolicy?: string | null;
  [k: string]: unknown;
};

async function applyRouteProbeGovernance(input: {
  channel: RouteChannelLike;
  route: RouteLike;
  probeModel: string;
  result: RouteProbeItem;
  autoGovernance: boolean;
}): Promise<RouteProbeItem> {
  if (!input.autoGovernance) {
    return {
      ...input.result,
      governanceAction: 'none',
      governanceReasonCode: null,
    };
  }

  const governanceReasonCode = mapProbeClassificationToGovernanceReason(input.result.probeClassification);
  const canClearGovernance = input.result.available && input.result.detectionMethod === 'realtime_probe';
  if (canClearGovernance) {
    let cleared = 0;
    if (typeof input.channel.tokenId === 'number' && input.channel.tokenId > 0) {
      cleared += await clearRoutingGovernanceStates({
        subjectType: 'token',
        subjectId: input.channel.tokenId,
        reasonCodes: ['auth', 'manual_recheck_needed'],
      });
      cleared += await clearRoutingGovernanceStates({
        subjectType: 'token',
        subjectId: input.channel.tokenId,
        modelName: input.probeModel,
        reasonCodes: ['model_unsupported'],
      });
    }
    cleared += await clearRoutingGovernanceStates({
      subjectType: 'account',
      subjectId: input.channel.accountId,
      reasonCodes: ['auth', 'manual_recheck_needed'],
    });
    cleared += await clearRoutingGovernanceStates({
      subjectType: 'account',
      subjectId: input.channel.accountId,
      modelName: input.probeModel,
      reasonCodes: ['model_unsupported'],
    });
    return {
      ...input.result,
      governanceAction: cleared > 0 ? 'cleared' : 'none',
      governanceReasonCode: null,
    };
  }

  if (input.result.available) {
    return {
      ...input.result,
      governanceAction: 'none',
      governanceReasonCode: null,
    };
  }

  if (!governanceReasonCode) {
    return {
      ...input.result,
      governanceAction: 'none',
      governanceReasonCode: null,
    };
  }

  const routeAllowsManualGovernance = (input.route.probePolicy || 'system') === 'manual';
  const governanceMarkerPrefix = routeAllowsManualGovernance ? `${MANUAL_ROUTE_PROBE_MARKER} ` : '';
  const reasonDetail = `${governanceMarkerPrefix}${input.result.reason}`.slice(0, 500)
    || (routeAllowsManualGovernance ? MANUAL_ROUTE_PROBE_MARKER : input.result.reason.slice(0, 500));
  const suppressUntil = governanceReasonCode === 'model_unsupported'
    ? nowPlusMs(12 * 60 * 60 * 1000)
    : nowPlusMs(30 * 60 * 1000);

  if (typeof input.channel.tokenId === 'number' && input.channel.tokenId > 0) {
    await upsertRoutingGovernanceState({
      subjectType: 'token',
      subjectId: input.channel.tokenId,
      modelName: governanceReasonCode === 'model_unsupported' ? input.probeModel : null,
      state: 'suppressed',
      reasonCode: governanceReasonCode,
      reasonDetail,
      probeModelName: input.probeModel,
      suppressUntil,
      probeAfter: suppressUntil,
      lastProbeAt: new Date().toISOString(),
      lastProbeStatus: input.result.available ? 'available' : 'unavailable',
      lastProbeMessage: input.result.reason,
      lastSuccessAt: input.result.available ? new Date().toISOString() : null,
      lastFailureAt: input.result.available ? null : new Date().toISOString(),
      failureCountDelta: input.result.available ? 0 : 1,
      successCountDelta: input.result.available ? 1 : 0,
    });
    return {
      ...input.result,
      governanceAction: 'suppressed',
      governanceReasonCode,
    };
  }

  await upsertRoutingGovernanceState({
    subjectType: 'account',
    subjectId: input.channel.accountId,
    modelName: governanceReasonCode === 'model_unsupported' ? input.probeModel : null,
    state: 'suppressed',
    reasonCode: governanceReasonCode,
    reasonDetail,
    probeModelName: input.probeModel,
    suppressUntil,
    probeAfter: suppressUntil,
    lastProbeAt: new Date().toISOString(),
    lastProbeStatus: input.result.available ? 'available' : 'unavailable',
    lastProbeMessage: input.result.reason,
    lastSuccessAt: input.result.available ? new Date().toISOString() : null,
    lastFailureAt: input.result.available ? null : new Date().toISOString(),
    failureCountDelta: input.result.available ? 0 : 1,
    successCountDelta: input.result.available ? 1 : 0,
  });
  return {
    ...input.result,
    governanceAction: 'suppressed',
    governanceReasonCode,
  };
}

// ── single route probe ───────────────────────────────────────────────

/**
 * Probe all enabled channels for a single route.
 *
 * This is the core logic extracted from POST /api/routes/:id/probe so it can
 * be called without a Fastify request context.
 */
export async function probeRouteChannelsForRoute(
  route: RouteLike,
  enabledChannels: RouteChannelLike[],
  options?: { limit?: number; autoGovernance?: boolean; earlyStopOnAvailable?: boolean },
): Promise<RouteProbeResponse> {
  const slicedChannels = enabledChannels.slice(0, resolveRouteProbeLimit(options?.limit));

  // Deduplicate by site: only probe the channel whose account has the highest balance per site.
  // Remaining channels for the same site are marked as skipped in the response.
  const bestChannelPerSite = new Map<number, RouteChannelLike>();
  const skippedByDedup: RouteChannelLike[] = [];
  for (const ch of slicedChannels) {
    const siteId: number = ch.site?.id ?? ch.accountId;
    const existing = bestChannelPerSite.get(siteId);
    if (!existing) {
      bestChannelPerSite.set(siteId, ch);
    } else {
      const balanceA = Number((existing as any).account?.balance ?? 0);
      const balanceB = Number((ch as any).account?.balance ?? 0);
      if (balanceB > balanceA) {
        skippedByDedup.push(existing);
        bestChannelPerSite.set(siteId, ch);
      } else {
        skippedByDedup.push(ch);
      }
    }
  }
  const channelsToProbe = Array.from(bestChannelPerSite.values());
  const skippedItems: RouteProbeItem[] = skippedByDedup.map((ch) => ({
    channelId: ch.id,
    accountId: ch.accountId,
    accountName: ch.account?.username || null,
    siteId: ch.site?.id ?? 0,
    siteName: ch.site?.name || `site-${ch.site?.id ?? 0}`,
    tokenId: ch.token?.id ?? null,
    tokenName: ch.token?.name ?? null,
    sourceModel: ch.sourceModel ?? null,
    available: false,
    reason: '同站点仅探测余额最高的账号',
    probeClassification: null,
    probeEndpoint: null,
    latencyMs: null,
    detectionMethod: 'unknown' as const,
    governanceAction: 'none' as const,
    governanceReasonCode: null,
  }));

  if (channelsToProbe.length === 0) {
    return {
      success: true,
      routeId: route.id,
      routeModelPattern: route.modelPattern,
      probedModel: route.modelPattern,
      autoGovernance: options?.autoGovernance === true,
      total: 0,
      availableCount: 0,
      unavailableCount: 0,
      skippedCount: 0,
      inconclusiveCount: 0,
      failedCount: 0,
      items: [],
    };
  }

  const autoGovernance = options?.autoGovernance === true;
  const earlyStop = options?.earlyStopOnAvailable === true;
  let foundAvailable = false;
  const items: RouteProbeItem[] = await mapWithConcurrency(channelsToProbe, ROUTE_PROBE_CONCURRENCY, async (channel) => {
    // Early stop: skip remaining channels once we found one available
    if (earlyStop && foundAvailable) {
      return {
        channelId: channel.id,
        accountId: channel.accountId,
        accountName: channel.account.username || null,
        siteId: channel.site.id,
        siteName: channel.site.name || `site-${channel.site.id}`,
        tokenId: channel.token?.id ?? null,
        tokenName: channel.token?.name ?? null,
        sourceModel: channel.sourceModel ?? null,
        available: false,
        reason: '已找到可用通道，跳过探测',
        probeClassification: null,
        probeEndpoint: null,
        latencyMs: null,
        detectionMethod: 'unknown' as const,
        governanceAction: 'none' as const,
        governanceReasonCode: null,
      } satisfies RouteProbeItem;
    }

    const probe = await probeMarketplaceModelAvailability({
      modelName: route.modelPattern,
      accountId: channel.accountId,
      siteName: channel.site.name || undefined,
      preferredTokenId: channel.token?.id ?? null,
      skipAutoCreate: false,
      forceRealtimeProbeOnListMiss: true,
      allowListHitSuccess: false,
    });

    const baseResult: RouteProbeItem = probe.success
      ? {
        channelId: channel.id,
        accountId: channel.accountId,
        accountName: channel.account.username || null,
        siteId: channel.site.id,
        siteName: channel.site.name || `site-${channel.site.id}`,
        tokenId: probe.usedTokenId ?? channel.token?.id ?? null,
        tokenName: probe.usedTokenName ?? channel.token?.name ?? null,
        sourceModel: channel.sourceModel ?? null,
        available: probe.available === true,
        inconclusive: probe.available !== true && (probe.probeClassification === 'inconclusive' || probe.probeClassification === 'protocol_mismatch') ? true : undefined,
        reason: probe.reason,
        probeClassification: probe.probeClassification ?? null,
        probeEndpoint: probe.probeEndpoint ?? null,
        latencyMs: probe.latencyMs ?? null,
        detectionMethod: probe.detectionMethod,
        governanceAction: 'none',
        governanceReasonCode: null,
        autoKeyCreated: probe.autoKeyCreated || undefined,
        autoKeyName: probe.autoKeyName,
      }
      : {
        channelId: channel.id,
        accountId: channel.accountId,
        accountName: channel.account.username || null,
        siteId: channel.site.id,
        siteName: channel.site.name || `site-${channel.site.id}`,
        tokenId: channel.token?.id ?? null,
        tokenName: channel.token?.name ?? null,
        sourceModel: channel.sourceModel ?? null,
        available: false,
        reason: probe.message || probe.error,
        probeClassification: classifyProbeClassificationFromError(probe.error),
        probeEndpoint: null,
        latencyMs: probe.latencyMs ?? null,
        detectionMethod: 'probe_failed',
        governanceAction: 'none',
        governanceReasonCode: null,
        autoKeyCreated: probe.autoKeyCreated || undefined,
        autoKeyName: probe.autoKeyName,
      } satisfies RouteProbeItem;

    if (baseResult.available) foundAvailable = true;

    return await applyRouteProbeGovernance({
      channel,
      route,
      probeModel: route.modelPattern,
      result: baseResult,
      autoGovernance,
    });
  });

  if (items.some((item) => item.governanceAction !== 'none')) {
    invalidateTokenRouterCache();
  }

  const allItems = [...items, ...skippedItems];

  return {
    success: true,
    routeId: route.id,
    routeModelPattern: route.modelPattern,
    probedModel: route.modelPattern,
    autoGovernance,
    total: allItems.length,
    availableCount: allItems.filter((item) => item.available).length,
    unavailableCount: allItems.filter((item) => !item.available && !item.inconclusive && item.detectionMethod !== 'unknown').length,
    skippedCount: allItems.filter((item) => !item.available && item.detectionMethod === 'unknown').length,
    inconclusiveCount: allItems.filter((item) => item.inconclusive === true).length,
    failedCount: allItems.filter((item) => item.detectionMethod === 'probe_failed').length,
    items: allItems,
  };
}

// ── batch probe ──────────────────────────────────────────────────────

const BATCH_PROBE_ROUTE_CONCURRENCY = 3;
const BATCH_PROBE_TOTAL_TIMEOUT_MS = 180_000;

export type BatchProbeResult = {
  results: RouteProbeResponse[];
  totalProbed: number;
};

/**
 * Probe multiple routes in parallel (up to 3 routes concurrently).
 * Total execution time is capped at 60 seconds.
 */
export async function probeBatchRoutes(
  routeChannelPairs: Array<{ route: RouteLike; channels: RouteChannelLike[] }>,
  options?: { limit?: number; autoGovernance?: boolean; earlyStopOnAvailable?: boolean },
): Promise<BatchProbeResult> {
  const deadline = Date.now() + BATCH_PROBE_TOTAL_TIMEOUT_MS;
  const results: RouteProbeResponse[] = [];

  // Use mapWithConcurrency but check deadline before each route
  const pairsToProbe = routeChannelPairs.filter(() => Date.now() < deadline);
  const probedResults = await mapWithConcurrency(
    pairsToProbe,
    BATCH_PROBE_ROUTE_CONCURRENCY,
    async (pair) => {
      if (Date.now() >= deadline) {
        return {
          success: true as const,
          routeId: pair.route.id,
          routeModelPattern: pair.route.modelPattern,
          probedModel: pair.route.modelPattern,
          autoGovernance: options?.autoGovernance === true,
          total: 0,
          availableCount: 0,
          unavailableCount: 0,
          skippedCount: 0,
          inconclusiveCount: 0,
          failedCount: 0,
          items: [],
        } satisfies RouteProbeResponse;
      }
      return probeRouteChannelsForRoute(pair.route, pair.channels, options);
    },
  );

  results.push(...probedResults);

  return {
    results,
    totalProbed: results.reduce((sum, r) => sum + r.total, 0),
  };
}

// ── auto-probe on failure ────────────────────────────────────────────

const AUTO_PROBE_THROTTLE_MS = 5 * 60 * 1000;
const autoProbeThrottle = new Map<string, number>();

/**
 * Triggered after a proxy request fails on all channels.
 * Probes only manual routes that match the failed model.
 */
export async function triggerRouteProbeForFailedModel(modelName: string): Promise<void> {
  const now = Date.now();
  const lastProbe = autoProbeThrottle.get(modelName) ?? 0;
  if (now - lastProbe < AUTO_PROBE_THROTTLE_MS) return;
  autoProbeThrottle.set(modelName, now);

  // Periodically prune stale throttle entries to prevent unbounded growth
  if (autoProbeThrottle.size > 200) {
    for (const [key, ts] of autoProbeThrottle) {
      if (now - ts >= AUTO_PROBE_THROTTLE_MS) autoProbeThrottle.delete(key);
    }
  }

  // Find exact-model routes that are enabled (both manual and system)
  const routes = await db.select().from(schema.tokenRoutes)
    .where(and(
      eq(schema.tokenRoutes.modelPattern, modelName),
      eq(schema.tokenRoutes.enabled, true),
    ))
    .all();

  if (routes.length === 0) return;

  // Load channels for each route — this reuses the same query pattern
  // as fetchChannelsForRouteRows but we keep it self-contained to avoid
  // circular imports with tokens.ts
  const routeChannelPairs: Array<{ route: RouteLike; channels: RouteChannelLike[] }> = [];

  for (const route of routes) {
    const channels = await db.select({
      channel: schema.routeChannels,
      account: schema.accounts,
      site: schema.sites,
      token: schema.accountTokens,
    })
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(schema.accountTokens, and(
        eq(schema.routeChannels.tokenId, schema.accountTokens.id),
        eq(schema.accountTokens.enabled, true),
      ))
      .where(eq(schema.routeChannels.routeId, route.id))
      .all();

    const enabledChannels: RouteChannelLike[] = channels
      .filter((row: { channel: { enabled: boolean | null } }) => row.channel.enabled !== false)
      .map((row: { channel: Record<string, unknown>; account: Record<string, unknown>; site: Record<string, unknown> & { id: number }; token: { id: number; name: string | null } | null }) => ({
        id: row.channel.id as number,
        accountId: row.account.id as number,
        tokenId: (row.token?.id ?? row.channel.tokenId ?? null) as number | null,
        enabled: row.channel.enabled as boolean | null,
        sourceModel: (row.channel.sourceModel ?? null) as string | null,
        account: row.account as Record<string, unknown>,
        site: row.site as Record<string, unknown> & { id: number },
        token: row.token ? { id: row.token.id as number, name: row.token.name as string | null } : null,
      }));

    routeChannelPairs.push({
      route: {
        id: route.id,
        modelPattern: route.modelPattern,
        probePolicy: route.probePolicy,
      },
      channels: enabledChannels,
    });
  }

  if (routeChannelPairs.length === 0) return;

  const batchResult = await probeBatchRoutes(routeChannelPairs, { autoGovernance: true });

  // Record the result as an event
  const totalAvailable = batchResult.results.reduce((s, r) => s + r.availableCount, 0);
  const totalUnavailable = batchResult.results.reduce((s, r) => s + r.unavailableCount, 0);
  const summary = batchResult.results
    .slice(0, 5)
    .map((r) => `${r.routeModelPattern}: ${r.availableCount}/${r.total} 可用`)
    .join('；');

  const { formatUtcSqlDateTime } = await import('./localTimeService.js');
  await db.insert(schema.events).values({
    type: 'status',
    title: '路由失败后自动探测已完成',
    message: `模型=${modelName}，探测 ${batchResult.totalProbed} 个通道：${totalAvailable} 可用，${totalUnavailable} 不可用${summary ? `；样本=${summary}` : ''}`,
    level: totalAvailable > 0 ? 'info' : 'warning',
    relatedType: 'route',
    createdAt: formatUtcSqlDateTime(new Date()),
  }).run();
}
