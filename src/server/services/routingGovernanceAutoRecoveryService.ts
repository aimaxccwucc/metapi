import { and, eq, inArray, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { refreshBalance } from './balanceService.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { config } from '../config.js';
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

const MODEL_UNSUPPORTED_RECHECK_MS = 12 * 60 * 60 * 1000;
const INVALID_CHANNEL_RECHECK_MS = 6 * 60 * 60 * 1000;
const UPSTREAM_GROUP_EMPTY_RECHECK_MS = 15 * 60 * 1000;
const SLOW_SITE_RECHECK_MS = 20 * 60 * 1000;
const MANUAL_ROUTE_PROBE_MARKER = '[manual_route_probe]';
const DEFAULT_PROBING_LEASE_MS = 10 * 60 * 1000;

/**
 * Re-enable route channels that were auto-disabled due to consecutive failures,
 * when a governance probe confirms the channel is healthy again.
 */
async function reEnableAutoDisabledChannels(entry: RoutingGovernanceEntry): Promise<void> {
  const threshold = config.channelAutoDisableOnConsecutiveFail;
  if (threshold <= 0) return;

  const conditions: ReturnType<typeof eq>[] = [];
  if (entry.subjectType === 'channel') {
    conditions.push(eq(schema.routeChannels.id, entry.subjectId));
  } else if (entry.subjectType === 'account') {
    conditions.push(eq(schema.routeChannels.accountId, entry.subjectId));
  } else if (entry.subjectType === 'token') {
    conditions.push(eq(schema.routeChannels.tokenId, entry.subjectId));
  } else if (entry.subjectType === 'site') {
    const accountIds = await db.select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.siteId, entry.subjectId))
      .all();
    if (accountIds.length > 0) {
      conditions.push(inArray(schema.routeChannels.accountId, accountIds.map((a: { id: number }) => a.id)));
    }
  }

  if (conditions.length === 0) return;

  const combinedCondition = conditions.length === 1
    ? and(conditions[0], eq(schema.routeChannels.enabled, false))
    : and(or(...conditions), eq(schema.routeChannels.enabled, false));

  if (!combinedCondition) return;

  await db.update(schema.routeChannels)
    .set({
      enabled: true,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
    })
    .where(combinedCondition)
    .run();
}

async function completeProbeAndRestore(
  entry: RoutingGovernanceEntry,
  input: Parameters<typeof completeRoutingGovernanceProbe>[1],
): Promise<void> {
  await completeRoutingGovernanceProbe(entry.id, input);
  if (input.restored) {
    await reEnableAutoDisabledChannels(entry).catch(() => {});
  }
}

function nowPlusMs(ms: number): string {
  return new Date(Date.now() + Math.max(1_000, Math.trunc(ms))).toISOString();
}

function resolveAutoRecoveryRecheckMs(): number {
  return Math.max(5 * 60_000, Math.trunc(config.routingAutoRecoveryRecheckMs || 0));
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
  if (
    fallback === 'auth'
    || fallback === 'model_unsupported'
    || fallback === 'invalid_channel'
    || fallback === 'managed_key_unstable'
    || fallback === 'returns_masked_only'
  ) return fallback;
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
      .leftJoin(schema.accountTokens, and(
        eq(schema.routeChannels.tokenId, schema.accountTokens.id),
        eq(schema.accountTokens.enabled, true),
      ))
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
  // 尝试轻量级探测验证限流是否真正解除
  const context = await resolveProbeContext(entry);
  if (context?.candidate && context.modelName) {
    try {
      const result = await testMarketplaceModelAvailabilityForCandidate({
        modelName: context.modelName,
        candidate: context.candidate,
        preferredTokenId: context.preferredTokenId,
        allowAutoCreateKey: false,
        probePrompt: config.autoProbePrompt,
        probeMaxOutputTokens: config.autoProbeMaxOutputTokens,
      });
      if (result.success && result.available) {
        await completeProbeAndRestore(entry, {
          restored: true,
          reasonCode: 'rate_limit',
          lastProbeStatus: 'available',
          lastProbeMessage: '限流避让窗口已过，探测确认可用，自动解除治理',
          lastSuccessAt: new Date().toISOString(),
          successCountDelta: 1,
        });
        return true;
      }
      // 探测到不可用，延长等待时间
      await completeRoutingGovernanceProbe(entry.id, {
        restored: false,
        reasonCode: 'rate_limit',
        lastProbeStatus: result.success ? 'unavailable' : 'probe_failed',
        lastProbeMessage: result.success ? result.reason : (result as any).message || '限流探测失败',
        suppressUntil: nowPlusMs(resolveAutoRecoveryRecheckMs()),
        probeAfter: nowPlusMs(resolveAutoRecoveryRecheckMs()),
        lastFailureAt: new Date().toISOString(),
        failureCountDelta: 1,
      });
      return false;
    } catch {
      // 探测异常，降级为被动释放
    }
  }
  // 无探测上下文或探测异常，被动释放
  await completeProbeAndRestore(entry, {
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
      suppressUntil: nowPlusMs(resolveAutoRecoveryRecheckMs()),
      probeAfter: nowPlusMs(resolveAutoRecoveryRecheckMs()),
    });
    return false;
  }

  let refreshResult: { balance?: number | null; used?: number | null; quota?: number | null; skipped?: boolean; reason?: string } | null = null;
  try {
    refreshResult = await refreshBalance(entry.subjectId);
  } catch (error: any) {
    await completeRoutingGovernanceProbe(entry.id, {
      restored: false,
      reasonCode: entry.reasonCode as RoutingGovernanceReasonCode,
      lastProbeStatus: 'balance_refresh_failed',
      lastProbeMessage: error?.message || '余额刷新失败',
      suppressUntil: nowPlusMs(resolveAutoRecoveryRecheckMs()),
      probeAfter: nowPlusMs(resolveAutoRecoveryRecheckMs()),
      lastFailureAt: new Date().toISOString(),
      failureCountDelta: 1,
    });
    return false;
  }

  // 检查刷新后的余额/配额是否仍然为 0
  if (refreshResult && !refreshResult.skipped) {
    const balance = typeof refreshResult.balance === 'number' ? refreshResult.balance : null;
    const quota = typeof refreshResult.quota === 'number' ? refreshResult.quota : null;
    const used = typeof refreshResult.used === 'number' ? refreshResult.used : 0;
    // 如果有配额信息且配额已用完，或者余额 <= 0，则不恢复
    const hasQuotaInfo = quota !== null && quota > 0;
    const quotaExhausted = hasQuotaInfo && used >= (quota ?? 0);
    const balanceExhausted = balance !== null && balance <= 0;
    if (quotaExhausted || balanceExhausted) {
      await completeRoutingGovernanceProbe(entry.id, {
        restored: false,
        reasonCode: entry.reasonCode as RoutingGovernanceReasonCode,
        lastProbeStatus: 'balance_still_zero',
        lastProbeMessage: `余额刷新后仍不可用：balance=${balance ?? '?'}, quota=${quota ?? '?'}, used=${used}`,
        suppressUntil: nowPlusMs(resolveAutoRecoveryRecheckMs()),
        probeAfter: nowPlusMs(resolveAutoRecoveryRecheckMs()),
        lastFailureAt: new Date().toISOString(),
        failureCountDelta: 1,
      });
      return false;
    }
  }

  // 余额正常或无法确认（被动释放）
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
      suppressUntil: nowPlusMs(resolveAutoRecoveryRecheckMs()),
      probeAfter: nowPlusMs(resolveAutoRecoveryRecheckMs()),
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
      probePrompt: config.autoProbePrompt,
      probeMaxOutputTokens: config.autoProbeMaxOutputTokens,
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
    await completeProbeAndRestore(entry, {
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
    : resolveAutoRecoveryRecheckMs();

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
  await completeProbeAndRestore(entry, {
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

  // auth / model_unsupported: 主动探测恢复（探测不可用或无上下文时已自动延长等待）
  if (reasonCode === 'auth' || reasonCode === 'model_unsupported') {
    return await handleProbeBasedRecovery(entry);
  }

  if (
    reasonCode === 'invalid_channel'
    || reasonCode === 'upstream_group_empty'
    || reasonCode === 'slow_site'
    || reasonCode === 'managed_key_unstable'
    || reasonCode === 'returns_masked_only'
  ) {
    return await handlePassiveExpiryRelease(entry);
  }

  // 如果属于 manual 路由则走完整的主动探测恢复。
  if (isManualRouteProbeGovernance(entry) && await isRouteEligibleForManualGovernance(entry)) {
    return await handleProbeBasedRecovery(entry);
  }

  return await handlePassiveExpiryRelease(entry);
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
    const supportsZeroCostRecovery = reasonCode === 'rate_limit'
      || reasonCode === 'balance_exhausted'
      || reasonCode === 'quota_exhausted';
    const allowActiveReprobe = isManualRouteProbeGovernance(state);
    const supportsProbeRecovery = reasonCode === 'auth' || reasonCode === 'model_unsupported';

    if (supportsZeroCostRecovery || allowActiveReprobe || supportsProbeRecovery) {
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
        suppressUntil: nowPlusMs(resolveAutoRecoveryRecheckMs()),
        probeAfter: nowPlusMs(resolveAutoRecoveryRecheckMs()),
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
  const itemSummary = result.items
    .slice(0, 5)
    .map((item) => `${item.subjectType}:${item.subjectId}/${item.modelName || '*'} -> ${item.action}`)
    .join('；');
  await db.insert(schema.events).values({
    type: 'status',
    title: '路由治理自动复测已执行',
    message: `扫描 ${result.scanned} 条，推进复测 ${result.promotedToProbing} 条，恢复 ${result.restored} 条，保留隔离 ${result.keptSuppressed} 条${itemSummary ? `；样本=${itemSummary}` : ''}`,
    level: result.restored > 0 ? 'info' : 'warning',
    relatedType: 'route',
    createdAt,
  }).run();
}
