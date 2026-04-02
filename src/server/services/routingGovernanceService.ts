import { and, asc, eq, inArray, lte, or, type SQL } from 'drizzle-orm';
import { db, runtimeDbDialect, schema } from '../db/index.js';

export type RoutingGovernanceSubjectType = 'site' | 'account' | 'token' | 'channel';
export type RoutingGovernanceState = 'suppressed' | 'probing';
export type RoutingGovernanceReasonCode =
  | 'auth'
  | 'rate_limit'
  | 'balance_exhausted'
  | 'quota_exhausted'
  | 'model_unsupported'
  | 'invalid_channel'
  | 'upstream_group_empty'
  | 'slow_site'
  | 'manual_recheck_needed';

export type RoutingGovernanceEntry = typeof schema.routingGovernanceStates.$inferSelect;

type UpsertGovernanceInput = {
  subjectType: RoutingGovernanceSubjectType;
  subjectId: number;
  modelName?: string | null;
  state?: RoutingGovernanceState;
  reasonCode: RoutingGovernanceReasonCode;
  reasonDetail?: string | null;
  probeModelName?: string | null;
  lastHttpStatus?: number | null;
  suppressUntil?: string | null;
  probeAfter?: string | null;
  lastFailureAt?: string | null;
  lastSuccessAt?: string | null;
  lastProbeAt?: string | null;
  lastProbeStatus?: string | null;
  lastProbeMessage?: string | null;
  failureCountDelta?: number;
  successCountDelta?: number;
};

export type ActiveGovernanceQuery = {
  subjectTypes?: RoutingGovernanceSubjectType[];
  states?: RoutingGovernanceState[];
  reasonCodes?: RoutingGovernanceReasonCode[];
  limit?: number;
};

export type ClearRoutingGovernanceQuery = {
  subjectType?: RoutingGovernanceSubjectType;
  subjectId?: number;
  subjectIds?: number[];
  modelName?: string | null;
  reasonCodes?: RoutingGovernanceReasonCode[];
  states?: RoutingGovernanceState[];
};

export type RoutingGovernanceRecoveryItem = {
  id: number;
  subjectType: RoutingGovernanceSubjectType;
  subjectId: number;
  modelName: string;
  action: 'promoted_to_probing' | 'already_probing';
  state: RoutingGovernanceState;
};

export type RoutingGovernanceRecoveryPassResult = {
  scanned: number;
  promotedToProbing: number;
  keptSuppressed: number;
  restored: number;
  skipped: number;
  items: RoutingGovernanceRecoveryItem[];
};

export type CandidateGovernanceContext = {
  channelId?: number | null;
  tokenId?: number | null;
  accountId?: number | null;
  siteId?: number | null;
  modelName?: string | null;
};

export type CandidateGovernanceBlock = {
  subjectType: RoutingGovernanceSubjectType;
  subjectId: number;
  modelName: string;
  reasonCode: RoutingGovernanceReasonCode;
  reasonDetail: string | null;
  suppressUntil: string | null;
  state: RoutingGovernanceState;
};

const DEFAULT_RECOVERY_PASS_LIMIT = 30;
const DEFAULT_PROBING_LEASE_MS = 10 * 60 * 1000;

function normalizeModelScope(modelName?: string | null): string {
  return (modelName || '').trim().toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMilliseconds(inputIso: string, ms: number): string {
  const baseMs = Date.parse(inputIso);
  const safeBaseMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(safeBaseMs + Math.max(1_000, Math.trunc(ms))).toISOString();
}

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function buildFilterWhere(input: ClearRoutingGovernanceQuery) {
  const conditions: SQL<unknown>[] = [];

  if (input.subjectType) {
    conditions.push(eq(schema.routingGovernanceStates.subjectType, input.subjectType));
  }

  if (isPositiveId(input.subjectId)) {
    conditions.push(eq(schema.routingGovernanceStates.subjectId, input.subjectId));
  } else if (Array.isArray(input.subjectIds) && input.subjectIds.length > 0) {
    const normalizedIds = Array.from(new Set(
      input.subjectIds
        .filter(isPositiveId)
        .map((item) => Math.trunc(item)),
    ));
    if (normalizedIds.length <= 0) return null;
    conditions.push(inArray(schema.routingGovernanceStates.subjectId, normalizedIds));
  }

  if (input.modelName !== undefined) {
    conditions.push(eq(schema.routingGovernanceStates.modelName, normalizeModelScope(input.modelName)));
  }

  if (Array.isArray(input.reasonCodes) && input.reasonCodes.length > 0) {
    conditions.push(inArray(schema.routingGovernanceStates.reasonCode, input.reasonCodes));
  }

  if (Array.isArray(input.states) && input.states.length > 0) {
    conditions.push(inArray(schema.routingGovernanceStates.state, input.states));
  }

  if (conditions.length <= 0) return null;
  return conditions.length === 1 ? conditions[0]! : and(...conditions);
}

export async function upsertRoutingGovernanceState(input: UpsertGovernanceInput): Promise<void> {
  if (!isPositiveId(input.subjectId)) return;

  const timestamp = nowIso();
  const normalizedModelName = normalizeModelScope(input.modelName);
  const existing = await db.select()
    .from(schema.routingGovernanceStates)
    .where(buildFilterWhere({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      modelName: normalizedModelName,
    })!)
    .get();

  const nextValues = {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    modelName: normalizedModelName,
    state: input.state ?? 'suppressed',
    reasonCode: input.reasonCode,
    reasonDetail: input.reasonDetail ?? existing?.reasonDetail ?? null,
    probeModelName: input.probeModelName ?? existing?.probeModelName ?? null,
    lastHttpStatus: input.lastHttpStatus ?? existing?.lastHttpStatus ?? null,
    failureCount: Math.max(0, (existing?.failureCount ?? 0) + (input.failureCountDelta ?? 0)),
    successCount: Math.max(0, (existing?.successCount ?? 0) + (input.successCountDelta ?? 0)),
    suppressUntil: input.suppressUntil ?? existing?.suppressUntil ?? null,
    probeAfter: input.probeAfter ?? existing?.probeAfter ?? null,
    lastFailureAt: input.lastFailureAt ?? existing?.lastFailureAt ?? null,
    lastSuccessAt: input.lastSuccessAt ?? existing?.lastSuccessAt ?? null,
    lastProbeAt: input.lastProbeAt ?? existing?.lastProbeAt ?? null,
    lastProbeStatus: input.lastProbeStatus ?? existing?.lastProbeStatus ?? null,
    lastProbeMessage: input.lastProbeMessage ?? existing?.lastProbeMessage ?? null,
    updatedAt: timestamp,
  };

  if (existing) {
    await db.update(schema.routingGovernanceStates)
      .set(nextValues)
      .where(eq(schema.routingGovernanceStates.id, existing.id))
      .run();
    return;
  }

  if (runtimeDbDialect === 'mysql') {
    await db.insert(schema.routingGovernanceStates)
      .values({
        ...nextValues,
        createdAt: timestamp,
      })
      .run();
    return;
  }

  await (db.insert(schema.routingGovernanceStates)
    .values({
      ...nextValues,
      createdAt: timestamp,
    }) as any)
    .onConflictDoUpdate({
      target: [
        schema.routingGovernanceStates.subjectType,
        schema.routingGovernanceStates.subjectId,
        schema.routingGovernanceStates.modelName,
      ],
      set: nextValues,
    })
    .run();
}

export async function clearRoutingGovernanceState(
  subjectType: RoutingGovernanceSubjectType,
  subjectId: number,
  modelName?: string | null,
): Promise<number> {
  return await clearRoutingGovernanceStates({
    subjectType,
    subjectId,
    modelName,
  });
}

export async function clearRoutingGovernanceStates(query: ClearRoutingGovernanceQuery): Promise<number> {
  const where = buildFilterWhere(query);
  if (!where) return 0;

  const result = await db.delete(schema.routingGovernanceStates)
    .where(where)
    .run();
  return Number(result?.changes || 0);
}

export async function clearRoutingGovernanceStatesBySubject(
  subjectType: RoutingGovernanceSubjectType,
  subjectIds: number[],
  options: {
    reasonCodes?: RoutingGovernanceReasonCode[];
    states?: RoutingGovernanceState[];
  } = {},
): Promise<number> {
  return await clearRoutingGovernanceStates({
    subjectType,
    subjectIds,
    reasonCodes: options.reasonCodes,
    states: options.states,
  });
}

export async function listActiveRoutingGovernanceStates(query: ActiveGovernanceQuery = {}): Promise<RoutingGovernanceEntry[]> {
  const where = buildFilterWhere({
    subjectIds: undefined,
    subjectType: undefined,
    modelName: undefined,
    ...(Array.isArray(query.subjectTypes) && query.subjectTypes.length > 0 ? { subjectType: undefined } : {}),
    reasonCodes: query.reasonCodes,
    states: query.states,
  });
  const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 200)));

  const builder = db.select()
    .from(schema.routingGovernanceStates)
    .orderBy(
      asc(schema.routingGovernanceStates.state),
      asc(schema.routingGovernanceStates.probeAfter),
      asc(schema.routingGovernanceStates.suppressUntil),
      asc(schema.routingGovernanceStates.updatedAt),
    );

  let rows = where
    ? await builder.where(where).limit(limit).all()
    : await builder.limit(limit).all();

  if (Array.isArray(query.subjectTypes) && query.subjectTypes.length > 0) {
    const allowed = new Set(query.subjectTypes);
    rows = rows.filter((item: RoutingGovernanceEntry) => allowed.has(item.subjectType as RoutingGovernanceSubjectType));
  }

  return rows;
}

export async function listDueRoutingGovernanceProbeStates(now = nowIso(), limit = DEFAULT_RECOVERY_PASS_LIMIT): Promise<RoutingGovernanceEntry[]> {
  return await db.select()
    .from(schema.routingGovernanceStates)
    .where(and(
      eq(schema.routingGovernanceStates.state, 'suppressed'),
      or(
        lte(schema.routingGovernanceStates.probeAfter, now),
        lte(schema.routingGovernanceStates.suppressUntil, now),
      ),
    ))
    .orderBy(
      asc(schema.routingGovernanceStates.probeAfter),
      asc(schema.routingGovernanceStates.suppressUntil),
      asc(schema.routingGovernanceStates.updatedAt),
    )
    .limit(Math.max(1, Math.min(200, Math.trunc(limit))))
    .all();
}

export async function markRoutingGovernanceProbeInFlight(
  id: number,
  now = nowIso(),
  probingLeaseMs = DEFAULT_PROBING_LEASE_MS,
): Promise<void> {
  if (!isPositiveId(id)) return;
  await db.update(schema.routingGovernanceStates)
    .set({
      state: 'probing',
      suppressUntil: null,
      probeAfter: addMilliseconds(now, probingLeaseMs),
      lastProbeAt: now,
      lastProbeStatus: 'promoted',
      updatedAt: now,
    })
    .where(eq(schema.routingGovernanceStates.id, id))
    .run();
}

export async function promoteRoutingGovernanceStateToProbing(id: number, now = nowIso()): Promise<void> {
  await markRoutingGovernanceProbeInFlight(id, now);
}

export async function completeRoutingGovernanceProbe(
  id: number,
  input: {
    restored: boolean;
    reasonCode: RoutingGovernanceReasonCode;
    lastProbeStatus: string;
    lastProbeMessage?: string | null;
    suppressUntil?: string | null;
    probeAfter?: string | null;
    lastSuccessAt?: string | null;
    lastFailureAt?: string | null;
    successCountDelta?: number;
    failureCountDelta?: number;
  },
): Promise<void> {
  if (!isPositiveId(id)) return;
  const existing = await db.select()
    .from(schema.routingGovernanceStates)
    .where(eq(schema.routingGovernanceStates.id, id))
    .get();
  if (!existing) return;

  if (input.restored) {
    await db.delete(schema.routingGovernanceStates)
      .where(eq(schema.routingGovernanceStates.id, id))
      .run();
    return;
  }

  await db.update(schema.routingGovernanceStates)
    .set({
      state: 'suppressed',
      reasonCode: input.reasonCode,
      lastProbeStatus: input.lastProbeStatus,
      lastProbeMessage: input.lastProbeMessage ?? null,
      suppressUntil: input.suppressUntil ?? existing.suppressUntil,
      probeAfter: input.probeAfter ?? existing.probeAfter,
      lastSuccessAt: input.lastSuccessAt ?? existing.lastSuccessAt,
      lastFailureAt: input.lastFailureAt ?? existing.lastFailureAt,
      failureCount: Math.max(0, (existing.failureCount ?? 0) + (input.failureCountDelta ?? 0)),
      successCount: Math.max(0, (existing.successCount ?? 0) + (input.successCountDelta ?? 0)),
      updatedAt: nowIso(),
    })
    .where(eq(schema.routingGovernanceStates.id, id))
    .run();
}

export async function runRoutingGovernanceRecoveryPass(options: {
  now?: string;
  limit?: number;
  includeProbing?: boolean;
  probingLeaseMs?: number;
} = {}): Promise<RoutingGovernanceRecoveryPassResult> {
  const now = options.now || nowIso();
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? DEFAULT_RECOVERY_PASS_LIMIT)));
  const probingLeaseMs = Math.max(1_000, Math.trunc(options.probingLeaseMs ?? DEFAULT_PROBING_LEASE_MS));
  const dueStates = await listDueRoutingGovernanceProbeStates(now, limit);

  let promotedToProbing = 0;
  let keptSuppressed = 0;
  const items: RoutingGovernanceRecoveryItem[] = [];

  for (const state of dueStates) {
    if (!isPositiveId(state.id)) {
      keptSuppressed += 1;
      continue;
    }
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
  }

  if (options.includeProbing) {
    const probingStates = await listActiveRoutingGovernanceStates({
      states: ['probing'],
      limit,
    });
    for (const state of probingStates) {
      if (!isPositiveId(state.id) || items.some((item) => item.id === state.id)) continue;
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

  return {
    scanned: options.includeProbing ? items.length : dueStates.length,
    promotedToProbing,
    keptSuppressed,
    restored: 0,
    skipped: keptSuppressed,
    items,
  };
}

export async function findCandidateGovernanceBlock(
  context: CandidateGovernanceContext,
  now = nowIso(),
): Promise<CandidateGovernanceBlock | null> {
  const subjectScopes: Array<{ subjectType: RoutingGovernanceSubjectType; subjectId: number }> = [];
  if (isPositiveId(context.channelId)) subjectScopes.push({ subjectType: 'channel', subjectId: context.channelId });
  if (isPositiveId(context.tokenId)) subjectScopes.push({ subjectType: 'token', subjectId: context.tokenId });
  if (isPositiveId(context.accountId)) subjectScopes.push({ subjectType: 'account', subjectId: context.accountId });
  if (isPositiveId(context.siteId)) subjectScopes.push({ subjectType: 'site', subjectId: context.siteId });
  if (subjectScopes.length <= 0) return null;

  const active = await listActiveRoutingGovernanceStates({
    subjectTypes: Array.from(new Set(subjectScopes.map((item) => item.subjectType))),
    states: ['suppressed', 'probing'],
    limit: 500,
  });
  const normalizedModel = normalizeModelScope(context.modelName);
  const rank = new Map<RoutingGovernanceSubjectType, number>([
    ['channel', 1],
    ['token', 2],
    ['account', 3],
    ['site', 4],
  ]);

  const matched = active
    .filter((item) => subjectScopes.some((scope) => scope.subjectType === item.subjectType && scope.subjectId === item.subjectId))
    .filter((item) => item.state === 'probing' || !item.suppressUntil || item.suppressUntil >= now)
    .filter((item) => item.modelName === '' || item.modelName === normalizedModel)
    .sort((left, right) => (
      (rank.get(left.subjectType as RoutingGovernanceSubjectType) ?? 99)
      - (rank.get(right.subjectType as RoutingGovernanceSubjectType) ?? 99)
      || (left.modelName ? 0 : 1) - (right.modelName ? 0 : 1)
      || (right.updatedAt || '').localeCompare(left.updatedAt || '')
    ));

  const hit = matched[0];
  if (!hit) return null;

  return {
    subjectType: hit.subjectType as RoutingGovernanceSubjectType,
    subjectId: hit.subjectId,
    modelName: hit.modelName,
    reasonCode: hit.reasonCode as RoutingGovernanceReasonCode,
    reasonDetail: hit.reasonDetail ?? null,
    suppressUntil: hit.suppressUntil ?? null,
    state: hit.state as RoutingGovernanceState,
  };
}
