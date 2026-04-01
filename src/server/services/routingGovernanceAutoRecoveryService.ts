import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { refreshBalance } from './balanceService.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import {
  MarketplaceModelProbeError,
  classifyProbeFailureMessage,
  testMarketplaceModelAvailabilityForCandidate,
  type MarketplaceProbeClassification,
  type MarketplaceModelAvailabilityFailure,
  type MarketplaceModelAvailabilitySuccess,
  type MarketplaceProbeCandidate,
} from './marketplaceModelProbeService.js';
import {
  completeRoutingGovernanceProbe,
  listDueRoutingGovernanceProbeStates,
  listActiveRoutingGovernanceStates,
  markRoutingGovernanceProbeInFlight,
  type RoutingGovernanceEntry,
  type RoutingGovernanceReasonCode,
  type RoutingGovernanceRecoveryPassResult,
  type RoutingGovernanceSubjectType,
} from './routingGovernanceService.js';

const AUTO_RECOVERY_RECHECK_MS = 30 * 60 * 1000;
const MODEL_UNSUPPORTED_RECHECK_MS = 12 * 60 * 60 * 1000;
const MANUAL_ROUTE_PROBE_MARKER = '[manual_route_probe]';
const DEFAULT_PROBING_LEASE_MS = 10 * 60 * 1000;

function nowPlusMs(ms: number): string {
  return new Date(Date.now() + Math.max(1_000, Math.trunc(ms))).toISOString();
}

function isExactModelPattern(modelPattern?: string | null): boolean {
  const pattern = String(modelPattern || '').trim();
  if (!pattern) return false;
  if (/^re:/i.test(pattern)) return false;
  if (pattern.includes('*') || pattern.includes('?')) return false;
  return true;
}

function isManualRouteProbeGovernance(entry: RoutingGovernanceEntry): boolean {
  return String(entry.reasonDetail || '').includes(MANUAL_ROUTE_PROBE_MARKER);
}

async function isRouteEligibleForManualGovernance(entry: RoutingGovernanceEntry): Promise<boolean> {
  if (entry.subjectType === 'token') {
    const rows = await db.select({
      routeProbePolicy: schema.tokenRoutes.probePolicy,
      routeMode: schema.tokenRoutes.routeMode,
      routeId: schema.tokenRoutes.id,
    })
      .from(schema.accountTokens)
      .leftJoin(schema.routeChannels, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
      .leftJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(eq(schema.accountTokens.id, entry.subjectId))
      .all();
    return rows.some((row) => row.routeProbePolicy === 'manual')
      || await hasManualExplicitGroupSource(rows);
  }

  if (entry.subjectType === 'account') {
    const rows = await db.select({
      routeProbePolicy: schema.tokenRoutes.probePolicy,
      routeMode: schema.tokenRoutes.routeMode,
      routeId: schema.tokenRoutes.id,
    })
      .from(schema.accounts)
      .leftJoin(schema.routeChannels, eq(schema.routeChannels.accountId, schema.accounts.id))
      .leftJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(eq(schema.accounts.id, entry.subjectId))
      .all();
    return rows.some((row) => row.routeProbePolicy === 'manual')
      || await hasManualExplicitGroupSource(rows);
  }

  if (entry.subjectType === 'channel') {
    const row = await db.select({
      routeProbePolicy: schema.tokenRoutes.probePolicy,
      routeMode: schema.tokenRoutes.routeMode,
      routeId: schema.tokenRoutes.id,
    })
      .from(schema.routeChannels)
      .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(eq(schema.routeChannels.id, entry.subjectId))
      .get();
    if (row?.routeProbePolicy === 'manual') return true;
    return await hasManualExplicitGroupSource(row ? [row] : []);
  }

  return false;
}

async function hasManualExplicitGroupSource(
  rows: Array<{ routeProbePolicy: string | null; routeMode: string | null; routeId: number | null }>,
): Promise<boolean> {
  const exactRouteIds = rows
    .filter((row) => row.routeMode !== 'explicit_group' && typeof row.routeId === 'number' && row.routeId > 0)
    .map((row) => row.routeId as number);
  if (exactRouteIds.length === 0) return false;

  const groupRows = await db.select({
    probePolicy: schema.tokenRoutes.probePolicy,
  })
    .from(schema.routeGroupSources)
    .innerJoin(schema.tokenRoutes, eq(schema.routeGroupSources.groupRouteId, schema.tokenRoutes.id))
    .where(and(
      eq(schema.tokenRoutes.routeMode, 'explicit_group'),
      inArray(schema.routeGroupSources.sourceRouteId, Array.from(new Set(exactRouteIds))),
    ))
    .all();
  return groupRows.some((row) => row.probePolicy === 'manual');
}

function mapProbeClassificationToReasonCode(
  classification: MarketplaceProbeClassification,
  fallback: RoutingGovernanceReasonCode,
): RoutingGovernanceReasonCode {
  if (classification === 'credential') return 'auth';
  if (classification === 'model_unavailable') return 'model_unsupported';
  if (fallback === 'auth' || fallback === 'model_unsupported') return fallback;
  return 'manual_recheck_needed';
}

async function getGovernanceEntryById(id: number): Promise<RoutingGovernanceEntry | null> {
  if (!(typeof id === 'number' && Number.isFinite(id) && id > 0)) return null;
  return await db.select()
    .from(schema.routingGovernanceStates)
    .where(eq(schema.routingGovernanceStates.id, id))
    .get();
}

async function resolveProbeContext(entry: RoutingGovernanceEntry): Promise<{
  modelName: string | null;
  candidate: MarketplaceProbeCandidate | null;
  preferredTokenId: number | null;
} | null> {
  const preferredModelName = (entry.probeModelName || entry.modelName || '').trim() || null;

  if (entry.subjectType === 'token') {
    const row = await db.select({
      token: schema.accountTokens,
      account: schema.accounts,
      site: schema.sites,
      routeModelPattern: schema.tokenRoutes.modelPattern,
    })
      .from(schema.accountTokens)
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(schema.routeChannels, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
      .leftJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(eq(schema.accountTokens.id, entry.subjectId))
      .get();
    if (!row) return null;
    return {
      modelName: preferredModelName || (isExactModelPattern(row.routeModelPattern) ? row.routeModelPattern.trim() : null),
      candidate: {
        account: row.account,
        site: row.site,
        token: row.token,
      },
      preferredTokenId: row.token.id,
    };
  }

  if (entry.subjectType === 'account') {
    const row = await db.select({
      account: schema.accounts,
      site: schema.sites,
      routeModelPattern: schema.tokenRoutes.modelPattern,
    })
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(schema.routeChannels, eq(schema.routeChannels.accountId, schema.accounts.id))
      .leftJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(eq(schema.accounts.id, entry.subjectId))
      .get();
    if (!row) return null;
    return {
      modelName: preferredModelName || (isExactModelPattern(row.routeModelPattern) ? row.routeModelPattern.trim() : null),
      candidate: {
        account: row.account,
        site: row.site,
        token: null,
      },
      preferredTokenId: null,
    };
  }

  if (entry.subjectType === 'channel') {
    const row = await db.select({
      account: schema.accounts,
      site: schema.sites,
      token: schema.accountTokens,
      tokenId: schema.routeChannels.tokenId,
      routeModelPattern: schema.tokenRoutes.modelPattern,
    })
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
      .where(eq(schema.routeChannels.id, entry.subjectId))
      .get();
    if (!row) return null;
    return {
      modelName: preferredModelName || (isExactModelPattern(row.routeModelPattern) ? row.routeModelPattern.trim() : null),
      candidate: {
        account: row.account,
        site: row.site,
        token: row.token ?? null,
      },
      preferredTokenId: typeof row.tokenId === 'number' && row.tokenId > 0 ? row.tokenId : null,
    };
  }

  if (entry.subjectType === 'site') {
    const row = await db.select({
      account: schema.accounts,
      site: schema.sites,
      routeModelPattern: schema.tokenRoutes.modelPattern,
    })
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(schema.routeChannels, eq(schema.routeChannels.accountId, schema.accounts.id))
      .leftJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(and(
        eq(schema.accounts.siteId, entry.subjectId),
        eq(schema.accounts.status, 'active'),
      ))
      .get();
    if (!row) return null;
    return {
      modelName: preferredModelName || (isExactModelPattern(row.routeModelPattern) ? row.routeModelPattern.trim() : null),
      candidate: {
        account: row.account,
        site: row.site,
        token: null,
      },
      preferredTokenId: null,
    };
  }

  return null;
}

async function handleRateLimitRecovery(entry: RoutingGovernanceEntry): Promise<boolean> {
  await completeRoutingGovernanceProbe(entry.id, {
    restored: true,
    reasonCode: 'rate_limit',
    lastProbeStatus: 'cooldown_elapsed',
    lastProbeMessage: '限流避让窗口已过，自动解除治理',
    lastSuccessAt: new Date().toISOString(),
    successCountDelta: 1,
  });
  return true;
}

async function handleBalanceRecovery(entry: RoutingGovernanceEntry): Promise<boolean> {
  if (entry.subjectType !== 'account') {
    await completeRoutingGovernanceProbe(entry.id, {
      restored: false,
      reasonCode: entry.reasonCode as RoutingGovernanceReasonCode,
      lastProbeStatus: 'skipped',
      lastProbeMessage: '当前治理主体不支持自动余额复测',
      suppressUntil: nowPlusMs(AUTO_RECOVERY_RECHECK_MS),
      probeAfter: nowPlusMs(AUTO_RECOVERY_RECHECK_MS),
    });
    return false;
  }

  try {
    await refreshBalance(entry.subjectId);
  } catch (error: any) {
    await completeRoutingGovernanceProbe(entry.id, {
      restored: false,
      reasonCode: entry.reasonCode as RoutingGovernanceReasonCode,
      lastProbeStatus: 'balance_refresh_failed',
      lastProbeMessage: error?.message || '余额刷新失败',
      suppressUntil: nowPlusMs(AUTO_RECOVERY_RECHECK_MS),
      probeAfter: nowPlusMs(AUTO_RECOVERY_RECHECK_MS),
      lastFailureAt: new Date().toISOString(),
      failureCountDelta: 1,
    });
    return false;
  }

  const remaining = await getGovernanceEntryById(entry.id);
  return !remaining;
}

async function handleProbeBasedRecovery(entry: RoutingGovernanceEntry): Promise<boolean> {
  const context = await resolveProbeContext(entry);
  if (!context?.candidate || !context.modelName) {
    await completeRoutingGovernanceProbe(entry.id, {
      restored: false,
      reasonCode: entry.reasonCode as RoutingGovernanceReasonCode,
      lastProbeStatus: 'skipped',
      lastProbeMessage: '自动复测缺少可用探测模型或账号上下文',
      suppressUntil: nowPlusMs(AUTO_RECOVERY_RECHECK_MS),
      probeAfter: nowPlusMs(AUTO_RECOVERY_RECHECK_MS),
    });
    return false;
  }

  let result: MarketplaceModelAvailabilitySuccess | MarketplaceModelAvailabilityFailure;
  try {
    result = await testMarketplaceModelAvailabilityForCandidate({
      modelName: context.modelName,
      candidate: context.candidate,
      preferredTokenId: context.preferredTokenId,
      allowAutoCreateKey: false,
    });
  } catch (error) {
    if (error instanceof MarketplaceModelProbeError) {
      const payload = error.payload as Partial<MarketplaceModelAvailabilityFailure> & Record<string, unknown>;
      result = {
        success: false,
        available: false,
        modelName: String(payload.modelName || context.modelName || ''),
        accountId: typeof payload.accountId === 'number' ? payload.accountId : context.candidate.account.id,
        accountName: typeof payload.accountName === 'string' ? payload.accountName : (context.candidate.account.username || null),
        siteId: typeof payload.siteId === 'number' ? payload.siteId : context.candidate.site.id,
        siteName: typeof payload.siteName === 'string' ? payload.siteName : (context.candidate.site.name || null),
        latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : null,
        error: String(payload.error || error.message || 'unknown error'),
        message: String(payload.message || payload.error || error.message || 'unknown error'),
        autoKeyCreated: false,
        autoKeyName: null,
        autoKeyGroup: null,
        autoKeyTokenId: null,
      };
    } else {
      result = {
        success: false,
        available: false,
        modelName: context.modelName,
        accountId: context.candidate.account.id,
        accountName: context.candidate.account.username || null,
        siteId: context.candidate.site.id,
        siteName: context.candidate.site.name || null,
        latencyMs: null,
        error: error instanceof Error ? error.message : String(error || 'unknown error'),
        message: error instanceof Error ? error.message : String(error || 'unknown error'),
        autoKeyCreated: false,
        autoKeyName: null,
        autoKeyGroup: null,
        autoKeyTokenId: null,
      };
    }
  }

  if (result.success && result.available) {
    await completeRoutingGovernanceProbe(entry.id, {
      restored: true,
      reasonCode: entry.reasonCode as RoutingGovernanceReasonCode,
      lastProbeStatus: 'available',
      lastProbeMessage: result.reason,
      lastSuccessAt: new Date().toISOString(),
      successCountDelta: 1,
    });
    return true;
  }

  const classification = result.success
    ? (result.probeClassification ?? 'inconclusive')
    : classifyProbeFailureMessage(result.error || result.message || '');
  const nextReasonCode = mapProbeClassificationToReasonCode(
    classification,
    entry.reasonCode as RoutingGovernanceReasonCode,
  );
  const nextWaitMs = nextReasonCode === 'model_unsupported'
    ? MODEL_UNSUPPORTED_RECHECK_MS
    : AUTO_RECOVERY_RECHECK_MS;

  await completeRoutingGovernanceProbe(entry.id, {
    restored: false,
    reasonCode: nextReasonCode,
    lastProbeStatus: result.success ? 'unavailable' : 'probe_failed',
    lastProbeMessage: result.success ? result.reason : result.message,
    suppressUntil: nowPlusMs(nextWaitMs),
    probeAfter: nowPlusMs(nextWaitMs),
    lastFailureAt: new Date().toISOString(),
    failureCountDelta: 1,
  });
  return false;
}

async function handlePassiveExpiryRelease(entry: RoutingGovernanceEntry): Promise<boolean> {
  await completeRoutingGovernanceProbe(entry.id, {
    restored: true,
    reasonCode: entry.reasonCode as RoutingGovernanceReasonCode,
    lastProbeStatus: 'passive_release',
    lastProbeMessage: '治理窗口已到期，未执行主动复测，交由真实请求重新验证',
    lastSuccessAt: new Date().toISOString(),
    successCountDelta: 1,
  });
  return true;
}

async function processProbingEntry(entry: RoutingGovernanceEntry): Promise<boolean> {
  if (!(typeof entry.id === 'number' && Number.isFinite(entry.id) && entry.id > 0)) return false;
  const reasonCode = entry.reasonCode as RoutingGovernanceReasonCode;

  if (reasonCode === 'rate_limit') {
    return await handleRateLimitRecovery(entry);
  }

  if (reasonCode === 'balance_exhausted' || reasonCode === 'quota_exhausted') {
    return await handleBalanceRecovery(entry);
  }

  if (!isManualRouteProbeGovernance(entry) || !await isRouteEligibleForManualGovernance(entry)) {
    return await handlePassiveExpiryRelease(entry);
  }

  return await handleProbeBasedRecovery(entry);
}

export async function executeRoutingGovernanceAutoRecoveryPass(options: {
  now?: string;
  limit?: number;
  includeProbing?: boolean;
  probingLeaseMs?: number;
} = {}): Promise<RoutingGovernanceRecoveryPassResult> {
  const now = options.now || new Date().toISOString();
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 30)));
  const probingLeaseMs = Math.max(1_000, Math.trunc(options.probingLeaseMs ?? DEFAULT_PROBING_LEASE_MS));
  const includeProbing = options.includeProbing !== false;
  const dueStates = await listDueRoutingGovernanceProbeStates(now, limit);

  let promotedToProbing = 0;
  let keptSuppressed = 0;
  let restored = 0;
  const items: RoutingGovernanceRecoveryPassResult['items'] = [];

  for (const state of dueStates) {
    if (!(typeof state.id === 'number' && Number.isFinite(state.id) && state.id > 0)) {
      keptSuppressed += 1;
      continue;
    }
    const reasonCode = state.reasonCode as RoutingGovernanceReasonCode;
    const supportsZeroCostRecovery = reasonCode === 'rate_limit' || reasonCode === 'balance_exhausted' || reasonCode === 'quota_exhausted';
    const allowActiveReprobe = isManualRouteProbeGovernance(state);

    if (supportsZeroCostRecovery || allowActiveReprobe) {
      await markRoutingGovernanceProbeInFlight(state.id, now, probingLeaseMs);
      promotedToProbing += 1;
      items.push({
        id: state.id,
        subjectType: state.subjectType as RoutingGovernanceSubjectType,
        subjectId: state.subjectId,
        modelName: state.modelName || '',
        action: 'promoted_to_probing',
        state: 'probing',
      });
      continue;
    }

    if (await handlePassiveExpiryRelease(state)) {
      restored += 1;
    } else {
      keptSuppressed += 1;
    }
  }

  const probingEntries = await listActiveRoutingGovernanceStates({
    states: ['probing'],
    limit,
  });

  if (includeProbing) {
    for (const state of probingEntries) {
      if (!(typeof state.id === 'number' && Number.isFinite(state.id) && state.id > 0)) continue;
      if (items.some((item) => item.id === state.id)) continue;
      items.push({
        id: state.id,
        subjectType: state.subjectType as RoutingGovernanceSubjectType,
        subjectId: state.subjectId,
        modelName: state.modelName || '',
        action: 'already_probing',
        state: 'probing',
      });
    }
  }

  for (const entry of probingEntries) {
    try {
      if (await processProbingEntry(entry)) {
        restored += 1;
      }
    } catch (error: any) {
      await completeRoutingGovernanceProbe(entry.id, {
        restored: false,
        reasonCode: 'manual_recheck_needed',
        lastProbeStatus: 'probe_failed',
        lastProbeMessage: error?.message || '自动复测执行失败',
        suppressUntil: nowPlusMs(AUTO_RECOVERY_RECHECK_MS),
        probeAfter: nowPlusMs(AUTO_RECOVERY_RECHECK_MS),
        lastFailureAt: new Date().toISOString(),
        failureCountDelta: 1,
      }).catch(() => {});
    }
  }

  return {
    scanned: dueStates.length,
    promotedToProbing,
    keptSuppressed,
    restored,
    skipped: 0,
    items,
  };
}

export async function recordRoutingGovernanceAutoRecoveryEvent(result: RoutingGovernanceRecoveryPassResult): Promise<void> {
  const createdAt = formatUtcSqlDateTime(new Date());
  await db.insert(schema.events).values({
    type: 'status',
    title: '路由治理自动复测已执行',
    message: `扫描 ${result.scanned} 条，推进复测 ${result.promotedToProbing} 条，恢复 ${result.restored} 条，保留隔离 ${result.keptSuppressed} 条`,
    level: result.restored > 0 ? 'info' : 'warning',
    relatedType: 'route',
    createdAt,
  }).run();
}
