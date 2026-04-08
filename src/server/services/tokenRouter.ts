import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { minimatch } from 'minimatch';
import { db, runtimeDbDialect, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { config } from '../config.js';
import { getCachedModelRoutingReferenceCost, refreshModelPricingCatalog } from './modelPricingService.js';
import {
  normalizeRouteRoutingStrategy,
  type RouteRoutingStrategy,
} from './routeRoutingStrategy.js';
import { type DownstreamRoutingPolicy, EMPTY_DOWNSTREAM_ROUTING_POLICY } from './downstreamPolicyTypes.js';
import { isUsableAccountToken } from './accountTokenService.js';
import { getOauthInfoFromExtraConfig } from './oauth/oauthAccount.js';
import {
  calculateChannelHealthScore,
  resolveRoundRobinCooldownMs,
  resolveWeightedFailureCooldownLevel,
  resolveWeightedFailureCooldownMs,
} from './channelRoutingHealth.js';
import {
  canUseModelCircuit,
  getModelCircuitStatus,
  openModelCircuitImmediately,
  recordModelCircuitFailure,
  recordModelCircuitSuccess,
  resetAllModelCircuits,
  type ModelCircuitFailureCategory,
  type ModelCircuitStatusView,
  injectCircuitPersistFns,
  loadPersistedModelCircuits,
} from './modelCircuitBreaker.js';
import { classifyProxyFailureCategory } from './proxyRetryPolicy.js';
import { parseCodexQuotaResetHint } from './oauth/quota.js';
import { extractRuntimeHealth } from './accountHealthService.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { isSiteReachableForRouting } from './siteLifecycleService.js';
import {
  clearRoutingGovernanceState,
  listActiveRoutingGovernanceStates,
  upsertRoutingGovernanceState,
  type CandidateGovernanceBlock,
  type RoutingGovernanceReasonCode,
  type RoutingGovernanceSubjectType,
} from './routingGovernanceService.js';

interface RouteMatch {
  route: RouteRow;
  channels: Array<{
    channel: typeof schema.routeChannels.$inferSelect & {
      sourceModel: string | null;
      sourceModelDerived: boolean;
    };
    account: typeof schema.accounts.$inferSelect;
    site: typeof schema.sites.$inferSelect;
    token: typeof schema.accountTokens.$inferSelect | null;
  }>;
}

type RouteChannelCandidate = RouteMatch['channels'][number];

interface SelectedChannel {
  channel: typeof schema.routeChannels.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  token: typeof schema.accountTokens.$inferSelect | null;
  tokenValue: string;
  tokenName: string;
  actualModel: string;
}

type FailureAwareChannel = {
  failCount?: number | null;
  lastFailAt?: string | null;
  consecutiveFailCount?: number | null;
  cooldownUntil?: string | null;
};

type PersistedUnavailableModelSnapshot = {
  tokenModels: Map<number, Map<string, number>>;
  accountModels: Map<number, Map<string, number>>;
};

type GovernanceSnapshot = {
  byScopeKey: Map<string, CandidateGovernanceBlock>;
};

export type PersistedUnavailableModelDiagnosticEntry = {
  scope: 'token' | 'account';
  ownerId: number;
  modelName: string;
  checkedAt: string | null;
  checkedAtMs: number;
  stillBlocking: boolean;
  ageMs: number;
};

type SiteRuntimeFailureContext = {
  status?: number | null;
  errorText?: string | null;
  modelName?: string | null;
  retryAfterHeader?: string | null;
  retryAfterMs?: number | null;
};

type SiteRuntimeHealthState = {
  penaltyScore: number;
  latencyEmaMs: number | null;
  transientFailureStreak: number;
  lastTransientFailureAtMs: number | null;
  breakerLevel: number;
  breakerUntilMs: number | null;
  lastUpdatedAtMs: number;
  lastFailureAtMs: number | null;
  lastSuccessAtMs: number | null;
};

const MIN_EFFECTIVE_UNIT_COST = 1e-6;
const ROUND_ROBIN_FAILURE_THRESHOLD = 3;
const MAX_ROUTE_REGEX_BODY_LENGTH = 256;
const SITE_RUNTIME_HEALTH_DECAY_HALF_LIFE_MS = 10 * 60 * 1000;
const SITE_RUNTIME_MIN_MULTIPLIER = 0.08;
const SITE_RUNTIME_LATENCY_BASELINE_MS = 2_500;
const SITE_RUNTIME_LATENCY_WINDOW_MS = 30_000;
const SITE_RUNTIME_MAX_LATENCY_PENALTY = 0.35;
const SITE_RUNTIME_LATENCY_EMA_ALPHA = 0.3;
const SITE_RUNTIME_BREAKER_STREAK_THRESHOLD = 3;
const SITE_RUNTIME_BREAKER_LEVELS_MS = [0, 60_000, 5 * 60_000, 30 * 60 * 1000] as const;
const SITE_TRANSIENT_STREAK_WINDOW_MS = 5 * 60 * 1000;
const SITE_HISTORICAL_HEALTH_MIN_MULTIPLIER = 0.45;
const SITE_HISTORICAL_HEALTH_MAX_SAMPLE = 24;
const SITE_HISTORICAL_LATENCY_BASELINE_MS = 2_000;
const SITE_HISTORICAL_LATENCY_WINDOW_MS = 20_000;
const SITE_HISTORICAL_MAX_LATENCY_PENALTY = 0.18;
const SITE_RUNTIME_HEALTH_SETTING_KEY = 'token_router_site_runtime_health_v1';
const SITE_RUNTIME_HEALTH_PERSIST_DEBOUNCE_MS = 500;
const SITE_RUNTIME_HEALTH_PERSIST_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SITE_RUNTIME_HEALTH_PERSIST_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
const SITE_RUNTIME_HEALTH_PERSIST_MIN_PENALTY = 0.02;
const ACCOUNT_ROUTING_HEALTH_SETTING_KEY = 'token_router_account_health_v1';
const ACCOUNT_ROUTING_BUDGET_SETTING_KEY = 'token_router_account_budget_v1';
const ACCOUNT_ROUTING_STICKY_SETTING_KEY = 'token_router_account_sticky_v1';
const ACCOUNT_ROUTING_PERSIST_DEBOUNCE_MS = 500;
const ACCOUNT_ROUTING_SYNC_INTERVAL_MS = 10_000;
const ACCOUNT_ROUTING_PERSIST_STALE_TTL_MS = 12 * 60 * 60 * 1000;
const ACCOUNT_ROUTING_PERSIST_IDLE_TTL_MS = 60 * 60 * 1000;
const PERSISTED_MODEL_UNAVAILABLE_TTL_MS = 6 * 60 * 60 * 1000;
const CHANNEL_SELECTION_LEASE_DEFAULT_MS = 30_000;
const CHANNEL_SELECTION_LEASE_MIN_MS = 15_000;
const CHANNEL_SELECTION_LEASE_MAX_MS = 90_000;
const ACCOUNT_SUCCESS_EMA_ALPHA = 0.25;
const ACCOUNT_LATENCY_EMA_ALPHA = 0.25;
const ACCOUNT_ROUTING_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const ACCOUNT_SELECTION_LEASE_IDLE_TTL_MS = 2 * 60 * 1000;
const ACCOUNT_STICKY_BINDING_TTL_MS = 5 * 60 * 1000;
const ACCOUNT_STICKY_FAILURE_BREAK_MS = 90 * 1000;
const ACCOUNT_STICKY_BUSY_BREAK_MS = 30 * 1000;
const ACCOUNT_RATE_LIMIT_BURST_MIN = 2;
const ACCOUNT_RATE_LIMIT_BURST_MAX = 6;
const ACCOUNT_RATE_LIMIT_REFILL_MIN_PER_SEC = 0.15;
const ACCOUNT_RATE_LIMIT_REFILL_MAX_PER_SEC = 1.2;
const SHORT_WINDOW_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const SITE_RUNTIME_IMMEDIATE_BREAKER_OVERRIDES_MS = {
  timeout: 20 * 60 * 1000,
  ssl: 25 * 60 * 1000,
  groupEmpty: 30 * 60 * 1000,
  badResponseWrapper: 90 * 60 * 1000,
} as const;
const CODEX_CLAUDE_SUCCESS_POOL_RECENT_MS = 4 * 60 * 60 * 1000;
const CODEX_CLAUDE_SUCCESS_POOL_SIZE = 4;

const SITE_PROTOCOL_FAILURE_PATTERNS: RegExp[] = [
  /unsupported\s+legacy\s+protocol/i,
  /please\s+use\s+\/v1\/responses/i,
  /please\s+use\s+\/v1\/messages/i,
  /please\s+use\s+\/v1\/chat\/completions/i,
  /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i,
  /unsupported\s+endpoint/i,
  /unsupported\s+path/i,
  /unknown\s+endpoint/i,
  /unrecognized\s+request\s+url/i,
  /no\s+route\s+matched/i,
];

const SITE_MODEL_FAILURE_PATTERNS: RegExp[] = [
  /unsupported\s+model/i,
  /model\s+not\s+supported/i,
  /does\s+not\s+support(?:\s+the)?\s+model/i,
  /no\s+such\s+model/i,
  /unknown\s+model/i,
  /invalid\s+model/i,
  /model.*does\s+not\s+exist/i,
  /当前\s*api\s*不支持所选模型/i,
  /不支持所选模型/i,
];

const SITE_VALIDATION_FAILURE_PATTERNS: RegExp[] = [
  /invalid\s+request\s+body/i,
  /validation/i,
  /missing\s+required/i,
  /required\s+parameter/i,
  /unknown\s+parameter/i,
  /unrecognized\s+(field|key|parameter)/i,
  /malformed/i,
  /invalid\s+json/i,
  /cannot\s+parse/i,
  /unsupported\s+media\s+type/i,
];

const DEFINITIVE_TOKEN_AUTH_FAILURE_PATTERNS: RegExp[] = [
  /invalid\s+api\s+key/i,
  /invalid[_\s-]?api[_\s-]?key/i,
  /api\s+key\s+not\s+found/i,
  /invalid\s+access\s+token/i,
  /access\s+token\s+has\s+expired/i,
  /expired\s+access\s+token/i,
  /expired\s+token/i,
  /jwt\s+expired/i,
  /token\s+expired/i,
];

const SITE_TRANSIENT_FAILURE_PATTERNS: RegExp[] = [
  /bad\s+gateway/i,
  /gateway\s+time-?out/i,
  /timed?\s*out/i,
  /timeout/i,
  /service\s+unavailable/i,
  /temporar(?:y|ily)\s+unavailable/i,
  /cpu\s+overloaded/i,
  /overloaded/i,
  /connection\s+reset/i,
  /connection\s+refused/i,
  /econnreset/i,
  /econnrefused/i,
];

const USAGE_LIMIT_RATE_LIMIT_PATTERNS: RegExp[] = [
  /usage_limit_reached/i,
  /usage\s+limit\s+has\s+been\s+reached/i,
  /quota\s+exceeded/i,
  /rate\s+limit/i,
  /\blimit\b/i,
];

type SiteRuntimeHealthPersistencePayload = {
  version: 1;
  savedAtMs: number;
  globalBySiteId: Record<string, SiteRuntimeHealthState>;
  modelBySiteId: Record<string, Record<string, SiteRuntimeHealthState>>;
};

type SiteRuntimeHealthDetails = {
  globalMultiplier: number;
  modelMultiplier: number;
  combinedMultiplier: number;
  globalBreakerOpen: boolean;
  modelBreakerOpen: boolean;
  modelKey: string;
};

export type SiteRuntimeHealthSnapshotEntry = {
  siteId: number;
  modelName: string | null;
  scope: 'global' | 'model';
  penaltyScore: number;
  latencyEmaMs: number | null;
  transientFailureStreak: number;
  breakerLevel: number;
  breakerUntilMs: number | null;
  lastUpdatedAtMs: number;
  lastFailureAtMs: number | null;
  lastSuccessAtMs: number | null;
  multiplier: number;
  breakerOpen: boolean;
};

type WeightedSelectionMode = 'weighted' | 'stable_first';
type ChannelSelectionLease = {
  expiresAtMs: number;
};
type AccountSelectionLease = {
  expiresAtMs: number;
};
type AccountRateBudgetState = {
  tokens: number;
  capacity: number;
  refillPerSec: number;
  lastRefillAtMs: number;
  lastGrantedAtMs: number | null;
  denyUntilMs: number | null;
  updatedAtMs: number;
};
type AccountRoutingState = {
  successEma: number;
  latencyEmaMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  consecutiveFailures: number;
  updatedAtMs: number;
};
type StickySessionBinding = {
  accountId: number;
  expiresAtMs: number;
  lastUsedAtMs: number;
};
type AccountRoutingHealthPersistencePayload = {
  version: 1;
  savedAtMs: number;
  byAccountId: Record<string, AccountRoutingState>;
};
type AccountRoutingBudgetPersistencePayload = {
  version: 1;
  savedAtMs: number;
  byAccountId: Record<string, {
    budget: AccountRateBudgetState;
    inflightLeases: AccountSelectionLease[];
  }>;
};
type AccountStickyBindingPersistencePayload = {
  version: 1;
  savedAtMs: number;
  byStickyKeyHash: Record<string, StickySessionBinding>;
};
type AccountRuntimeSnapshotEntry = {
  accountId: number;
  siteId: number;
  successEma: number;
  latencyEmaMs: number | null;
  inflightCount: number;
  concurrencyBudget: number;
  rateLimitCapacity: number;
  rateLimitTokens: number;
  rateLimitRefillPerSec: number;
  rateLimitedUntilMs: number | null;
  rateLimited: boolean;
  stickyActiveCount: number;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  consecutiveFailures: number;
};

const siteRuntimeHealthStates = new Map<number, SiteRuntimeHealthState>();
const siteModelRuntimeHealthStates = new Map<number, Map<string, SiteRuntimeHealthState>>();
const channelSelectionLeases = new Map<number, ChannelSelectionLease>();
const accountSelectionLeases = new Map<number, AccountSelectionLease[]>();
const accountRoutingStates = new Map<number, AccountRoutingState>();
const accountRateBudgetStates = new Map<number, AccountRateBudgetState>();
const stickySessionBindings = new Map<string, StickySessionBinding>();
const stickySessionKeyByChannel = new Map<number, string>();
let siteRuntimeHealthLoaded = false;
let siteRuntimeHealthLoadPromise: Promise<void> | null = null;
let siteRuntimeHealthSaveTimer: ReturnType<typeof setTimeout> | null = null;
let siteRuntimeHealthPersistInFlight: Promise<void> | null = null;
let accountRuntimeLoaded = false;
let accountRuntimeLoadPromise: Promise<void> | null = null;
let accountRuntimeSaveTimer: ReturnType<typeof setTimeout> | null = null;
let accountRuntimePersistInFlight: Promise<void> | null = null;
let accountRuntimeLastSyncedAtMs = 0;

function createEmptyPersistedUnavailableModelSnapshot(): PersistedUnavailableModelSnapshot {
  return {
    tokenModels: new Map<number, Map<string, number>>(),
    accountModels: new Map<number, Map<string, number>>(),
  };
}

function createEmptyGovernanceSnapshot(): GovernanceSnapshot {
  return {
    byScopeKey: new Map<string, CandidateGovernanceBlock>(),
  };
}

function buildGovernanceScopeKey(
  subjectType: RoutingGovernanceSubjectType,
  subjectId: number,
  modelName?: string | null,
): string {
  return `${subjectType}:${subjectId}:${normalizeModelAlias(modelName || '')}`;
}

function appendUnavailableModel(
  target: Map<number, Map<string, number>>,
  ownerId: number,
  modelName: string,
  checkedAtMs: number,
): void {
  if (!Number.isFinite(ownerId) || ownerId <= 0) return;
  const normalizedModelName = normalizeModelAlias(modelName);
  if (!normalizedModelName) return;
  if (!Number.isFinite(checkedAtMs) || checkedAtMs <= 0) return;
  if (!target.has(ownerId)) {
    target.set(ownerId, new Map<string, number>());
  }
  target.get(ownerId)!.set(normalizedModelName, checkedAtMs);
}

function isPersistedUnavailableModelStillBlocking(checkedAtMs: number, nowMs = Date.now()): boolean {
  return Number.isFinite(checkedAtMs) && checkedAtMs > 0 && (nowMs - checkedAtMs) < PERSISTED_MODEL_UNAVAILABLE_TTL_MS;
}

function appendPersistedUnavailableModelDiagnosticEntries(
  entries: PersistedUnavailableModelDiagnosticEntry[],
  scope: 'token' | 'account',
  ownerId: number,
  models: Map<string, number>,
  nowMs = Date.now(),
): void {
  if (!Number.isFinite(ownerId) || ownerId <= 0) return;
  for (const [modelName, checkedAtMs] of models.entries()) {
    if (!modelName || !Number.isFinite(checkedAtMs) || checkedAtMs <= 0) continue;
    const stillBlocking = isPersistedUnavailableModelStillBlocking(checkedAtMs, nowMs);
    entries.push({
      scope,
      ownerId,
      modelName,
      checkedAt: new Date(checkedAtMs).toISOString(),
      checkedAtMs,
      stillBlocking,
      ageMs: Math.max(0, nowMs - checkedAtMs),
    });
  }
}

export async function listPersistedUnavailableModelEntries(): Promise<PersistedUnavailableModelDiagnosticEntry[]> {
  const nowMs = Date.now();
  const entries: PersistedUnavailableModelDiagnosticEntry[] = [];

  const [tokenRows, accountRows] = await Promise.all([
    db.select({
      tokenId: schema.tokenModelAvailability.tokenId,
      modelName: schema.tokenModelAvailability.modelName,
      checkedAt: schema.tokenModelAvailability.checkedAt,
    }).from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.available, false))
      .all(),
    db.select({
      accountId: schema.modelAvailability.accountId,
      modelName: schema.modelAvailability.modelName,
      checkedAt: schema.modelAvailability.checkedAt,
    }).from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.available, false))
      .all(),
  ]);

  const tokenEntries = new Map<number, Map<string, number>>();
  const accountEntries = new Map<number, Map<string, number>>();

  for (const row of tokenRows) {
    const tokenId = Math.trunc(row.tokenId);
    if (!Number.isFinite(tokenId) || tokenId <= 0) continue;
    const modelName = normalizeModelAlias(String(row.modelName || ''));
    if (!modelName) continue;
    const checkedAtMs = parseIsoTimeMs(String(row.checkedAt || '')) ?? nowMs;
    appendUnavailableModel(tokenEntries, tokenId, modelName, checkedAtMs);
  }
  for (const row of accountRows) {
    const accountId = Math.trunc(row.accountId);
    if (!Number.isFinite(accountId) || accountId <= 0) continue;
    const modelName = normalizeModelAlias(String(row.modelName || ''));
    if (!modelName) continue;
    const checkedAtMs = parseIsoTimeMs(String(row.checkedAt || '')) ?? nowMs;
    appendUnavailableModel(accountEntries, accountId, modelName, checkedAtMs);
  }

  for (const [tokenId, models] of tokenEntries.entries()) {
    appendPersistedUnavailableModelDiagnosticEntries(entries, 'token', tokenId, models, nowMs);
  }
  for (const [accountId, models] of accountEntries.entries()) {
    appendPersistedUnavailableModelDiagnosticEntries(entries, 'account', accountId, models, nowMs);
  }

  entries.sort((left, right) => (
    Number(right.stillBlocking) - Number(left.stillBlocking)
    || right.checkedAtMs - left.checkedAtMs
    || left.scope.localeCompare(right.scope, undefined, { sensitivity: 'base' })
    || left.ownerId - right.ownerId
    || left.modelName.localeCompare(right.modelName, undefined, { sensitivity: 'base' })
  ));
  return entries;
}

async function loadPersistedUnavailableModelsForCandidates(
  candidates: RouteChannelCandidate[],
): Promise<PersistedUnavailableModelSnapshot> {
  const snapshot = createEmptyPersistedUnavailableModelSnapshot();
  if (candidates.length === 0) return snapshot;
  const nowMs = Date.now();

  const tokenIds = Array.from(new Set(
    candidates
      .map((candidate) => (
        typeof candidate.channel.tokenId === 'number' && candidate.channel.tokenId > 0
          ? candidate.channel.tokenId
          : null
      ))
      .filter((value): value is number => typeof value === 'number'),
  ));
  const accountIds = Array.from(new Set(
    candidates
      .map((candidate) => Math.trunc(candidate.account.id))
      .filter((value) => Number.isFinite(value) && value > 0),
  ));

  if (tokenIds.length > 0) {
    const tokenRows = await db.select({
      tokenId: schema.tokenModelAvailability.tokenId,
      modelName: schema.tokenModelAvailability.modelName,
      checkedAt: schema.tokenModelAvailability.checkedAt,
    }).from(schema.tokenModelAvailability)
      .where(
        and(
          inArray(schema.tokenModelAvailability.tokenId, tokenIds),
          eq(schema.tokenModelAvailability.available, false),
        ),
      )
      .all();
    for (const row of tokenRows) {
      const checkedAtMs = parseIsoTimeMs(String(row.checkedAt || '')) ?? nowMs;
      if (!isPersistedUnavailableModelStillBlocking(checkedAtMs, nowMs)) continue;
      const normalizedModelName = normalizeModelAlias(String(row.modelName || ''));
      appendUnavailableModel(snapshot.tokenModels, row.tokenId, normalizedModelName, checkedAtMs);
    }
  }

  if (accountIds.length > 0) {
    const accountRows = await db.select({
      accountId: schema.modelAvailability.accountId,
      modelName: schema.modelAvailability.modelName,
      checkedAt: schema.modelAvailability.checkedAt,
    }).from(schema.modelAvailability)
      .where(
        and(
          inArray(schema.modelAvailability.accountId, accountIds),
          eq(schema.modelAvailability.available, false),
        ),
      )
      .all();
    for (const row of accountRows) {
      const checkedAtMs = parseIsoTimeMs(String(row.checkedAt || '')) ?? nowMs;
      if (!isPersistedUnavailableModelStillBlocking(checkedAtMs, nowMs)) continue;
      const normalizedModelName = normalizeModelAlias(String(row.modelName || ''));
      appendUnavailableModel(snapshot.accountModels, row.accountId, normalizedModelName, checkedAtMs);
    }
  }

  return snapshot;
}

async function loadGovernanceSnapshotForCandidates(
  candidates: RouteChannelCandidate[],
): Promise<GovernanceSnapshot> {
  const snapshot = createEmptyGovernanceSnapshot();
  if (candidates.length <= 0) return snapshot;

  const subjectTypeSet = new Set<RoutingGovernanceSubjectType>();
  const subjectIdByType = new Map<RoutingGovernanceSubjectType, Set<number>>();
  const modelNames = new Set<string>();

  for (const candidate of candidates) {
    if (typeof candidate.channel.id === 'number' && candidate.channel.id > 0) {
      subjectTypeSet.add('channel');
      if (!subjectIdByType.has('channel')) subjectIdByType.set('channel', new Set<number>());
      subjectIdByType.get('channel')!.add(candidate.channel.id);
    }
    if (typeof candidate.channel.tokenId === 'number' && candidate.channel.tokenId > 0) {
      subjectTypeSet.add('token');
      if (!subjectIdByType.has('token')) subjectIdByType.set('token', new Set<number>());
      subjectIdByType.get('token')!.add(candidate.channel.tokenId);
    }
    if (typeof candidate.account.id === 'number' && candidate.account.id > 0) {
      subjectTypeSet.add('account');
      if (!subjectIdByType.has('account')) subjectIdByType.set('account', new Set<number>());
      subjectIdByType.get('account')!.add(candidate.account.id);
    }
    if (typeof candidate.site.id === 'number' && candidate.site.id > 0) {
      subjectTypeSet.add('site');
      if (!subjectIdByType.has('site')) subjectIdByType.set('site', new Set<number>());
      subjectIdByType.get('site')!.add(candidate.site.id);
    }
    const normalizedSourceModel = normalizeModelAlias(candidate.channel.sourceModel || '');
    if (normalizedSourceModel) modelNames.add(normalizedSourceModel);
  }

  const states = await listActiveRoutingGovernanceStates({
    subjectTypes: Array.from(subjectTypeSet),
    states: ['suppressed', 'probing'],
    limit: 500,
  });

  for (const state of states) {
    const subjectType = state.subjectType as RoutingGovernanceSubjectType;
    const subjectIds = subjectIdByType.get(subjectType);
    if (!subjectIds || !subjectIds.has(state.subjectId)) continue;
    const normalizedModelName = normalizeModelAlias(state.modelName || '');
    if (normalizedModelName && !modelNames.has(normalizedModelName)) {
      continue;
    }
    const key = buildGovernanceScopeKey(subjectType, state.subjectId, normalizedModelName);
    if (!snapshot.byScopeKey.has(key)) {
      snapshot.byScopeKey.set(key, {
        subjectType,
        subjectId: state.subjectId,
        modelName: normalizedModelName,
        reasonCode: state.reasonCode as RoutingGovernanceReasonCode,
        reasonDetail: state.reasonDetail ?? null,
        suppressUntil: state.suppressUntil ?? null,
        state: state.state as 'suppressed' | 'probing',
      });
    }
  }

  return snapshot;
}

function findGovernanceBlockFromSnapshot(
  snapshot: GovernanceSnapshot | undefined,
  candidate: RouteChannelCandidate,
  runtimeModelName?: string | null,
): CandidateGovernanceBlock | null {
  if (!snapshot) return null;
  const normalizedModelName = normalizeModelAlias(runtimeModelName || '');
  const lookups: Array<[RoutingGovernanceSubjectType, number | null]> = [
    ['channel', candidate.channel.id ?? null],
    ['token', (typeof candidate.channel.tokenId === 'number' && candidate.channel.tokenId > 0) ? candidate.channel.tokenId : null],
    ['account', candidate.account.id ?? null],
    ['site', candidate.site.id ?? null],
  ];
  for (const [subjectType, subjectId] of lookups) {
    if (!(typeof subjectId === 'number' && subjectId > 0)) continue;
    const exactKey = buildGovernanceScopeKey(subjectType, subjectId, normalizedModelName);
    const globalKey = buildGovernanceScopeKey(subjectType, subjectId, '');
    const hit = snapshot.byScopeKey.get(exactKey) || snapshot.byScopeKey.get(globalKey) || null;
    if (hit) return hit;
  }
  return null;
}

function formatGovernanceReason(block: CandidateGovernanceBlock): string {
  const subjectLabelMap: Record<RoutingGovernanceSubjectType, string> = {
    channel: '通道',
    token: '令牌',
    account: '账号',
    site: '站点',
  };
  const reasonLabelMap: Record<RoutingGovernanceReasonCode, string> = {
    auth: '鉴权失效',
    rate_limit: '限流中',
    balance_exhausted: '余额不足',
    quota_exhausted: '额度不足',
    model_unsupported: '模型不可用',
    invalid_channel: '通道无效',
    upstream_group_empty: '上游通道池空',
    slow_site: '慢站点熔断',
    manual_recheck_needed: '待复测',
  };
  const detail = block.reasonDetail?.replace('[manual_route_probe]', '').trim();
  const stateLabel = block.state === 'probing' ? '系统复测中' : '系统隔离';
  const base = `${stateLabel}：${subjectLabelMap[block.subjectType] || block.subjectType} / ${reasonLabelMap[block.reasonCode] || block.reasonCode}`;
  return detail ? `${base}（${detail}）` : base;
}

function resolveGovernanceSuppression(
  input: {
    failureCategory: ReturnType<typeof classifyProxyFailureCategory>;
    channel: typeof schema.routeChannels.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    status?: number | null;
    modelName?: string | null;
    errorText?: string | null;
    cooldownUntil?: string | null;
  },
): { subjectType: RoutingGovernanceSubjectType; subjectId: number; modelName?: string | null; reasonCode: RoutingGovernanceReasonCode } | null {
  const normalizedModelName = normalizeModelAlias(input.modelName || '');
  const normalizedStatus = typeof input.status === 'number' && Number.isFinite(input.status)
    ? Math.trunc(input.status)
    : 0;
  const errorText = (input.errorText || '').trim();
  const protocolMismatchText = /does\s+not\s+allow\s+\/v1\/|unsupported\s+endpoint|unsupported\s+path|please\s+use\s+\/v1\//i
    .test(errorText);
  if ((normalizedStatus === 400 || normalizedStatus === 403 || normalizedStatus === 404) && protocolMismatchText) {
    return null;
  }
  if (input.failureCategory === 'auth') {
    if (typeof input.channel.tokenId === 'number' && input.channel.tokenId > 0) {
      return {
        subjectType: 'token',
        subjectId: input.channel.tokenId,
        reasonCode: 'auth',
      };
    }
    return {
      subjectType: 'account',
      subjectId: input.account.id,
      reasonCode: 'auth',
    };
  }
  if (input.failureCategory === 'rate_limit') {
    if (typeof input.channel.tokenId === 'number' && input.channel.tokenId > 0) {
      return {
        subjectType: 'token',
        subjectId: input.channel.tokenId,
        reasonCode: 'rate_limit',
      };
    }
    return {
      subjectType: 'account',
      subjectId: input.account.id,
      reasonCode: 'rate_limit',
    };
  }
  if (input.failureCategory === 'model_unsupported' && normalizedModelName) {
    if (typeof input.channel.tokenId === 'number' && input.channel.tokenId > 0) {
      return {
        subjectType: 'token',
        subjectId: input.channel.tokenId,
        modelName: normalizedModelName,
        reasonCode: 'model_unsupported',
      };
    }
    return {
      subjectType: 'account',
      subjectId: input.account.id,
      modelName: normalizedModelName,
      reasonCode: 'model_unsupported',
    };
  }
  if (input.failureCategory === 'invalid_channel' && normalizedModelName) {
    const siteScopedInvalidChannel = /无权访问\s*.+\s*分组|no\s+access\s+to\s+group|no\s+tool\s+output\s+found\s+for\s+function\s+call/i
      .test(errorText)
      || isGenericBadResponseStatusWrapper(errorText);
    if (siteScopedInvalidChannel) {
      return {
        subjectType: 'site',
        subjectId: input.account.siteId,
        modelName: normalizedModelName,
        reasonCode: 'invalid_channel',
      };
    }
    return {
      subjectType: 'channel',
      subjectId: input.channel.id,
      modelName: normalizedModelName,
      reasonCode: 'invalid_channel',
    };
  }
  if (input.failureCategory === 'upstream_group_empty' && normalizedModelName) {
    return {
      subjectType: 'site',
      subjectId: input.account.siteId,
      modelName: normalizedModelName,
      reasonCode: 'upstream_group_empty',
    };
  }
  if ((input.failureCategory === 'network' || input.failureCategory === 'server') && normalizedModelName) {
    const errorTextLower = errorText.toLowerCase();
    const isSlowSiteFailure = normalizedStatus === 524
      || /timeout|timed?\s*out|cloudflare\s+524|upstream\s+timeout/.test(errorTextLower);
    if (isSlowSiteFailure) {
      return {
        subjectType: 'site',
        subjectId: input.account.siteId,
        modelName: normalizedModelName,
        reasonCode: 'slow_site',
      };
    }
  }
  return null;
}

function isCandidatePersistentlyUnavailableForModel(
  candidate: RouteChannelCandidate,
  runtimeModelName: string | null | undefined,
  snapshot?: PersistedUnavailableModelSnapshot,
  nowMs = Date.now(),
): boolean {
  if (!snapshot) return false;
  const normalizedModelName = normalizeModelAlias(runtimeModelName || '');
  if (!normalizedModelName) return false;

  const tokenId = typeof candidate.channel.tokenId === 'number' && candidate.channel.tokenId > 0
    ? candidate.channel.tokenId
    : null;
  if (tokenId != null) {
    const checkedAtMs = snapshot.tokenModels.get(tokenId)?.get(normalizedModelName);
    if (typeof checkedAtMs === 'number' && isPersistedUnavailableModelStillBlocking(checkedAtMs, nowMs)) {
      return true;
    }
  }

  const checkedAtMs = snapshot.accountModels.get(candidate.account.id)?.get(normalizedModelName);
  return typeof checkedAtMs === 'number' && isPersistedUnavailableModelStillBlocking(checkedAtMs, nowMs);
}

function resolveSiteRuntimeBreakerMs(level: number): number {
  const normalizedLevel = Math.max(0, Math.min(SITE_RUNTIME_BREAKER_LEVELS_MS.length - 1, Math.trunc(level)));
  return SITE_RUNTIME_BREAKER_LEVELS_MS[normalizedLevel] ?? 0;
}

function matchesAnyPattern(patterns: RegExp[], input?: string | null): boolean {
  const text = (input || '').trim();
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

function isUsageLimitRateLimitFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  if (status !== 429) return false;
  return matchesAnyPattern(USAGE_LIMIT_RATE_LIMIT_PATTERNS, context.errorText);
}

function isCodexOrClaudePreferenceModel(modelName?: string | null): boolean {
  const normalized = normalizeModelAlias(modelName || '');
  return normalized.includes('codex') || normalized.includes('claude');
}

function isGenericBadResponseStatusWrapper(errorText?: string | null): boolean {
  const text = (errorText || '').trim().toLowerCase();
  if (!text) return false;
  return (
    text.includes('bad_response_status_code')
    || text.includes('bad response status code 400')
    || (text.includes('openai_error') && text.includes('bad response status code'))
  );
}

function isSslHandshakeFailure(errorText?: string | null): boolean {
  return /ssl\s+handshake\s+failed|cloudflare\s+525|error\s+525/i.test((errorText || '').trim());
}

function isTimeoutLikeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  return status === 524
    || /timeout|timed?\s*out|gateway\s*time-?out|cloudflare\s+524|upstream\s+timeout/i.test(errorText);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readFiniteInteger(value: unknown): number | null {
  const normalized = readFiniteNumber(value);
  return normalized == null ? null : Math.trunc(normalized);
}

function readNullableTimestamp(value: unknown): number | null {
  const normalized = readFiniteInteger(value);
  if (normalized == null || normalized <= 0) return null;
  return normalized;
}

function parseRetryAfterMs(rawValue?: string | null, nowMs = Date.now()): number | null {
  const normalized = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!normalized) return null;

  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(0, Math.trunc(seconds * 1000));
  }

  const retryAtMs = Date.parse(normalized);
  if (!Number.isFinite(retryAtMs)) return null;
  return Math.max(0, retryAtMs - nowMs);
}

function resolveRetryAfterMsFromContext(
  context: SiteRuntimeFailureContext = {},
  nowMs = Date.now(),
): number | null {
  if (typeof context.retryAfterMs === 'number' && Number.isFinite(context.retryAfterMs) && context.retryAfterMs >= 0) {
    return Math.trunc(context.retryAfterMs);
  }
  return parseRetryAfterMs(context.retryAfterHeader, nowMs);
}

function resolveSiteRuntimeFailurePenalty(context: SiteRuntimeFailureContext = {}): number {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();

  if (isUsageLimitRateLimitFailure({ status, errorText })) {
    return 0.4;
  }

  if (status >= 500 || matchesAnyPattern(SITE_TRANSIENT_FAILURE_PATTERNS, errorText)) {
    return 2.5;
  }

  if (status === 429) {
    return 2.2;
  }

  if (status === 401 || status === 403) {
    return 1.8;
  }

  if (matchesAnyPattern(SITE_PROTOCOL_FAILURE_PATTERNS, errorText)) {
    return 0.6;
  }

  if (matchesAnyPattern(SITE_MODEL_FAILURE_PATTERNS, errorText)) {
    return 0.9;
  }

  if (matchesAnyPattern(SITE_VALIDATION_FAILURE_PATTERNS, errorText)) {
    return 0.25;
  }

  if (status >= 400 && status < 500) {
    return 0.9;
  }

  return 1.2;
}

function resolveImmediateModelBreakerDurationMs(context: SiteRuntimeFailureContext = {}): number {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();

  if (status === 401 || status === 403) {
    return 30 * 60 * 1000;
  }
  if (matchesAnyPattern(SITE_MODEL_FAILURE_PATTERNS, errorText)) {
    return 20 * 60 * 1000;
  }
  if (matchesAnyPattern(SITE_VALIDATION_FAILURE_PATTERNS, errorText)) {
    return 10 * 60 * 1000;
  }
  return 0;
}

function resolveImmediateSiteRuntimeBreakerDurationMs(context: SiteRuntimeFailureContext = {}): number {
  const category = classifyProxyFailureCategory(context.status, context.errorText);
  if (category === 'upstream_group_empty') return SITE_RUNTIME_IMMEDIATE_BREAKER_OVERRIDES_MS.groupEmpty;
  if (isGenericBadResponseStatusWrapper(context.errorText)) return SITE_RUNTIME_IMMEDIATE_BREAKER_OVERRIDES_MS.badResponseWrapper;
  if (isSslHandshakeFailure(context.errorText)) return SITE_RUNTIME_IMMEDIATE_BREAKER_OVERRIDES_MS.ssl;
  if (isTimeoutLikeFailure(context)) return SITE_RUNTIME_IMMEDIATE_BREAKER_OVERRIDES_MS.timeout;
  return 0;
}

function resolveExtendedChannelCooldownMs(context: SiteRuntimeFailureContext = {}): number {
  const category = classifyProxyFailureCategory(context.status, context.errorText);
  if (category === 'upstream_group_empty') return SITE_RUNTIME_IMMEDIATE_BREAKER_OVERRIDES_MS.groupEmpty;
  if (isSslHandshakeFailure(context.errorText)) return SITE_RUNTIME_IMMEDIATE_BREAKER_OVERRIDES_MS.ssl;
  if (isTimeoutLikeFailure(context)) return SITE_RUNTIME_IMMEDIATE_BREAKER_OVERRIDES_MS.timeout;
  return 0;
}

function isAuthLikeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  if (matchesAnyPattern(SITE_PROTOCOL_FAILURE_PATTERNS, errorText)) return false;
  if (status === 401 || status === 403) return true;
  return /invalid\s+api\s+key|invalid\s+access\s+token|unauthorized|forbidden/i.test(errorText);
}

function resolveAuthFailureCooldownSec(context: SiteRuntimeFailureContext = {}): number {
  return isAuthLikeFailure(context) ? 30 * 60 : 0;
}

function isDefinitiveTokenCredentialFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(DEFINITIVE_TOKEN_AUTH_FAILURE_PATTERNS, context.errorText);
}

function shouldOpenImmediateModelCircuitForFailure(
  context: SiteRuntimeFailureContext = {},
): ModelCircuitFailureCategory | null {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();

  if (matchesAnyPattern(SITE_PROTOCOL_FAILURE_PATTERNS, errorText)) {
    return null;
  }
  if (status === 401 || status === 403 || isDefinitiveTokenCredentialFailure(context)) {
    return 'auth';
  }
  if (matchesAnyPattern(SITE_MODEL_FAILURE_PATTERNS, errorText)) {
    return 'model_unsupported';
  }
  return null;
}

function shouldSkipModelCircuitForFailure(
  context: SiteRuntimeFailureContext = {},
): boolean {
  return matchesAnyPattern(SITE_PROTOCOL_FAILURE_PATTERNS, context.errorText);
}

function shouldApplyImmediateRoundRobinCooldown(category: ReturnType<typeof classifyProxyFailureCategory>): boolean {
  return category === 'auth'
    || category === 'model_unsupported'
    || category === 'payload_too_large'
    || category === 'rate_limit'
    || category === 'invalid_channel'
    || category === 'upstream_group_empty';
}

function shouldApplySiteWideFailureTracking(context: SiteRuntimeFailureContext = {}): boolean {
  const category = classifyProxyFailureCategory(context.status, context.errorText);
  const errorText = (context.errorText || '').trim();
  return category === 'network'
    || category === 'server'
    || category === 'rate_limit'
    || category === 'upstream_group_empty'
    || (category === 'invalid_channel' && isGenericBadResponseStatusWrapper(errorText))
    || (category === 'invalid_channel' && /无权访问\s*.+\s*分组|no\s+access\s+to\s+group|no\s+tool\s+output\s+found\s+for\s+function\s+call/i.test(errorText));
}

function shouldApplySiteModelFailureTracking(context: SiteRuntimeFailureContext = {}): boolean {
  const category = classifyProxyFailureCategory(context.status, context.errorText);
  return category === 'network'
    || category === 'server'
    || category === 'rate_limit'
    || category === 'upstream_group_empty'
    || category === 'model_unsupported'
    || (category === 'invalid_channel' && isGenericBadResponseStatusWrapper(context.errorText));
}

function isTransientSiteRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  if (isUsageLimitRateLimitFailure({ status, errorText })) {
    return false;
  }
  return status >= 500 || status === 429 || matchesAnyPattern(SITE_TRANSIENT_FAILURE_PATTERNS, errorText);
}

function buildCredentialScopedCooldownFingerprint(
  account: typeof schema.accounts.$inferSelect,
  channel: typeof schema.routeChannels.$inferSelect,
): string | null {
  if (typeof channel.tokenId === 'number' && channel.tokenId > 0) {
    return `token:${channel.tokenId}`;
  }

  const oauth = getOauthInfoFromExtraConfig(account.extraConfig);
  if (oauth?.provider) {
    const accountKey = String(oauth.accountKey || oauth.accountId || oauth.email || '').trim().toLowerCase();
    if (accountKey) {
      return `oauth:${oauth.provider}:${accountKey}`;
    }
  }

  if (typeof account.id === 'number' && account.id > 0) {
    return `account:${account.id}`;
  }

  return null;
}

function resolveShortWindowLimitCooldownUntil(
  account: typeof schema.accounts.$inferSelect,
  context: SiteRuntimeFailureContext = {},
  nowMs = Date.now(),
): string | null {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  if (!isUsageLimitRateLimitFailure({ status, errorText })) return null;

  const explicitRetryAfterMs = resolveRetryAfterMsFromContext(context, nowMs);
  if (explicitRetryAfterMs != null && explicitRetryAfterMs > 0) {
    return new Date(nowMs + explicitRetryAfterMs).toISOString();
  }

  const resetHint = parseCodexQuotaResetHint(status, errorText, nowMs);
  if (resetHint?.resetAt) {
    const hintMs = Date.parse(resetHint.resetAt);
    if (Number.isFinite(hintMs) && hintMs > nowMs) {
      return new Date(hintMs).toISOString();
    }
  }

  const oauth = getOauthInfoFromExtraConfig(account.extraConfig);
  const storedResetAt = oauth?.quota?.lastLimitResetAt;
  if (storedResetAt) {
    const storedMs = Date.parse(storedResetAt);
    if (Number.isFinite(storedMs) && storedMs > nowMs) {
      return new Date(storedMs).toISOString();
    }
  }

  return new Date(nowMs + SHORT_WINDOW_LIMIT_COOLDOWN_MS).toISOString();
}

async function loadCredentialScopedChannelIds(
  channel: typeof schema.routeChannels.$inferSelect,
  account: typeof schema.accounts.$inferSelect,
): Promise<number[]> {
  if (typeof channel.tokenId === 'number' && channel.tokenId > 0) {
    const tokenRows = await db.select({ id: schema.routeChannels.id })
      .from(schema.routeChannels)
      .where(eq(schema.routeChannels.tokenId, channel.tokenId))
      .all();
    return tokenRows.map((row: { id: number }) => row.id);
  }

  const credentialScope = buildCredentialScopedCooldownFingerprint(account, channel);
  if (credentialScope?.startsWith('oauth:')) {
    const rows = await db.select({
      channelId: schema.routeChannels.id,
      accountId: schema.accounts.id,
      extraConfig: schema.accounts.extraConfig,
      tokenId: schema.routeChannels.tokenId,
    })
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .all();
    return rows
      .filter((row: {
        channelId: number;
        accountId: number;
        extraConfig: string | null;
        tokenId: number | null;
      }) => {
        const currentChannel = { tokenId: row.tokenId } as typeof schema.routeChannels.$inferSelect;
        const currentAccount = { id: row.accountId, extraConfig: row.extraConfig } as typeof schema.accounts.$inferSelect;
        return buildCredentialScopedCooldownFingerprint(currentAccount, currentChannel) === credentialScope;
      })
      .map((row: { channelId: number }) => row.channelId);
  }

  const accountRows = await db.select({ id: schema.routeChannels.id })
    .from(schema.routeChannels)
    .where(and(
      eq(schema.routeChannels.accountId, account.id),
      isNull(schema.routeChannels.tokenId),
    ))
    .all();
  return accountRows.map((row: { id: number }) => row.id);
}

function getDecayedSiteRuntimePenalty(state: SiteRuntimeHealthState, nowMs: number): number {
  if (!Number.isFinite(state.penaltyScore) || state.penaltyScore <= 0) return 0;
  const elapsedMs = Math.max(0, nowMs - state.lastUpdatedAtMs);
  if (elapsedMs <= 0) return state.penaltyScore;
  const decayFactor = Math.pow(0.5, elapsedMs / SITE_RUNTIME_HEALTH_DECAY_HALF_LIFE_MS);
  return state.penaltyScore * decayFactor;
}

function hydrateSiteRuntimeHealthState(raw: unknown): SiteRuntimeHealthState | null {
  if (!isRecord(raw)) return null;

  const lastUpdatedAtMs = readFiniteInteger(raw.lastUpdatedAtMs) ?? Date.now();
  return {
    penaltyScore: Math.max(0, readFiniteNumber(raw.penaltyScore) ?? 0),
    latencyEmaMs: readFiniteNumber(raw.latencyEmaMs),
    transientFailureStreak: Math.max(0, readFiniteInteger(raw.transientFailureStreak) ?? 0),
    lastTransientFailureAtMs: readNullableTimestamp(raw.lastTransientFailureAtMs),
    breakerLevel: Math.max(0, readFiniteInteger(raw.breakerLevel) ?? 0),
    breakerUntilMs: readNullableTimestamp(raw.breakerUntilMs),
    lastUpdatedAtMs: Math.max(0, lastUpdatedAtMs),
    lastFailureAtMs: readNullableTimestamp(raw.lastFailureAtMs),
    lastSuccessAtMs: readNullableTimestamp(raw.lastSuccessAtMs),
  };
}

function cloneSiteRuntimeHealthState(state: SiteRuntimeHealthState): SiteRuntimeHealthState {
  return {
    penaltyScore: state.penaltyScore,
    latencyEmaMs: state.latencyEmaMs,
    transientFailureStreak: state.transientFailureStreak,
    lastTransientFailureAtMs: state.lastTransientFailureAtMs,
    breakerLevel: state.breakerLevel,
    breakerUntilMs: state.breakerUntilMs,
    lastUpdatedAtMs: state.lastUpdatedAtMs,
    lastFailureAtMs: state.lastFailureAtMs,
    lastSuccessAtMs: state.lastSuccessAtMs,
  };
}

function cloneAccountRoutingState(state: AccountRoutingState): AccountRoutingState {
  return {
    successEma: state.successEma,
    latencyEmaMs: state.latencyEmaMs,
    lastSuccessAtMs: state.lastSuccessAtMs,
    lastFailureAtMs: state.lastFailureAtMs,
    consecutiveFailures: state.consecutiveFailures,
    updatedAtMs: state.updatedAtMs,
  };
}

function cloneAccountRateBudgetState(state: AccountRateBudgetState): AccountRateBudgetState {
  return {
    tokens: state.tokens,
    capacity: state.capacity,
    refillPerSec: state.refillPerSec,
    lastRefillAtMs: state.lastRefillAtMs,
    lastGrantedAtMs: state.lastGrantedAtMs,
    denyUntilMs: state.denyUntilMs,
    updatedAtMs: state.updatedAtMs,
  };
}

function hashStickySessionKey(stickySessionKey: string): string {
  return createHash('sha256').update(stickySessionKey).digest('hex');
}

function hydrateAccountRoutingState(raw: unknown): AccountRoutingState | null {
  if (!isRecord(raw)) return null;
  return {
    successEma: clampNumber(readFiniteNumber(raw.successEma) ?? 0.5, 0, 1),
    latencyEmaMs: readFiniteNumber(raw.latencyEmaMs),
    lastSuccessAtMs: readNullableTimestamp(raw.lastSuccessAtMs),
    lastFailureAtMs: readNullableTimestamp(raw.lastFailureAtMs),
    consecutiveFailures: Math.max(0, readFiniteInteger(raw.consecutiveFailures) ?? 0),
    updatedAtMs: Math.max(0, readFiniteInteger(raw.updatedAtMs) ?? Date.now()),
  };
}

function hydrateAccountRateBudgetState(raw: unknown): AccountRateBudgetState | null {
  if (!isRecord(raw)) return null;
  const capacity = clampNumber(readFiniteNumber(raw.capacity) ?? ACCOUNT_RATE_LIMIT_BURST_MIN, ACCOUNT_RATE_LIMIT_BURST_MIN, ACCOUNT_RATE_LIMIT_BURST_MAX);
  const refillPerSec = clampNumber(readFiniteNumber(raw.refillPerSec) ?? ACCOUNT_RATE_LIMIT_REFILL_MIN_PER_SEC, ACCOUNT_RATE_LIMIT_REFILL_MIN_PER_SEC, ACCOUNT_RATE_LIMIT_REFILL_MAX_PER_SEC);
  return {
    tokens: clampNumber(readFiniteNumber(raw.tokens) ?? capacity, 0, capacity),
    capacity,
    refillPerSec,
    lastRefillAtMs: Math.max(0, readFiniteInteger(raw.lastRefillAtMs) ?? Date.now()),
    lastGrantedAtMs: readNullableTimestamp(raw.lastGrantedAtMs),
    denyUntilMs: readNullableTimestamp(raw.denyUntilMs),
    updatedAtMs: Math.max(0, readFiniteInteger(raw.updatedAtMs) ?? Date.now()),
  };
}

function hydrateStickySessionBinding(raw: unknown): StickySessionBinding | null {
  if (!isRecord(raw)) return null;
  const accountId = readFiniteInteger(raw.accountId);
  if (accountId == null || accountId <= 0) return null;
  const expiresAtMs = readNullableTimestamp(raw.expiresAtMs);
  if (expiresAtMs == null) return null;
  return {
    accountId,
    expiresAtMs,
    lastUsedAtMs: readNullableTimestamp(raw.lastUsedAtMs) ?? expiresAtMs,
  };
}

function getOrCreateRuntimeHealthState<K>(states: Map<K, SiteRuntimeHealthState>, key: K, nowMs = Date.now()): SiteRuntimeHealthState {
  const existing = states.get(key);
  if (!existing) {
    const initial: SiteRuntimeHealthState = {
      penaltyScore: 0,
      latencyEmaMs: null,
      transientFailureStreak: 0,
      lastTransientFailureAtMs: null,
      breakerLevel: 0,
      breakerUntilMs: null,
      lastUpdatedAtMs: nowMs,
      lastFailureAtMs: null,
      lastSuccessAtMs: null,
    };
    states.set(key, initial);
    return initial;
  }

  const nextPenalty = getDecayedSiteRuntimePenalty(existing, nowMs);
  if (nextPenalty !== existing.penaltyScore || existing.lastUpdatedAtMs !== nowMs) {
    existing.penaltyScore = nextPenalty;
    existing.lastUpdatedAtMs = nowMs;
  }
  return existing;
}

function getOrCreateSiteRuntimeHealthState(siteId: number, nowMs = Date.now()): SiteRuntimeHealthState {
  return getOrCreateRuntimeHealthState(siteRuntimeHealthStates, siteId, nowMs);
}

function getSiteModelRuntimeHealthState(siteId: number, modelName?: string | null): SiteRuntimeHealthState | null {
  const modelKey = normalizeModelAlias(modelName || '');
  if (!modelKey) return null;
  return siteModelRuntimeHealthStates.get(siteId)?.get(modelKey) ?? null;
}

function getOrCreateSiteModelRuntimeHealthState(
  siteId: number,
  modelName?: string | null,
  nowMs = Date.now(),
): SiteRuntimeHealthState | null {
  const modelKey = normalizeModelAlias(modelName || '');
  if (!modelKey) return null;
  let modelStates = siteModelRuntimeHealthStates.get(siteId);
  if (!modelStates) {
    modelStates = new Map<string, SiteRuntimeHealthState>();
    siteModelRuntimeHealthStates.set(siteId, modelStates);
  }
  return getOrCreateRuntimeHealthState(modelStates, modelKey, nowMs);
}

function isRuntimeHealthBreakerOpen(state: SiteRuntimeHealthState | null | undefined, nowMs = Date.now()): boolean {
  if (!state) return false;
  return typeof state.breakerUntilMs === 'number' && state.breakerUntilMs > nowMs;
}

function getRuntimeHealthMultiplier(state: SiteRuntimeHealthState | null | undefined, nowMs = Date.now()): number {
  if (!state) return 1;
  if (isRuntimeHealthBreakerOpen(state, nowMs)) {
    return SITE_RUNTIME_MIN_MULTIPLIER;
  }
  const penaltyScore = getDecayedSiteRuntimePenalty(state, nowMs);
  const failurePenaltyFactor = 1 / (1 + penaltyScore);
  const latencyPenaltyRatio = state.latencyEmaMs == null
    ? 0
    : clampNumber(
      (state.latencyEmaMs - SITE_RUNTIME_LATENCY_BASELINE_MS) / SITE_RUNTIME_LATENCY_WINDOW_MS,
      0,
      1,
    );
  const latencyFactor = 1 - (latencyPenaltyRatio * SITE_RUNTIME_MAX_LATENCY_PENALTY);
  return clampNumber(failurePenaltyFactor * latencyFactor, SITE_RUNTIME_MIN_MULTIPLIER, 1);
}

function getSiteRuntimeHealthDetails(siteId: number, modelName?: string | null, nowMs = Date.now()): SiteRuntimeHealthDetails {
  const modelKey = normalizeModelAlias(modelName || '');
  const globalState = siteRuntimeHealthStates.get(siteId);
  const modelState = modelKey ? getSiteModelRuntimeHealthState(siteId, modelKey) : null;
  const globalMultiplier = getRuntimeHealthMultiplier(globalState, nowMs);
  const modelMultiplier = modelState ? getRuntimeHealthMultiplier(modelState, nowMs) : 1;
  return {
    globalMultiplier,
    modelMultiplier,
    combinedMultiplier: clampNumber(
      globalMultiplier * modelMultiplier,
      SITE_RUNTIME_MIN_MULTIPLIER * SITE_RUNTIME_MIN_MULTIPLIER,
      1,
    ),
    globalBreakerOpen: isRuntimeHealthBreakerOpen(globalState, nowMs),
    modelBreakerOpen: isRuntimeHealthBreakerOpen(modelState, nowMs),
    modelKey,
  };
}

function shouldOpenImmediateRuntimeBreaker(context: SiteRuntimeFailureContext = {}): boolean {
  const category = classifyProxyFailureCategory(context.status, context.errorText);
  const errorText = (context.errorText || '').trim();
  return category === 'network'
    || category === 'server'
    || category === 'rate_limit'
    || category === 'upstream_group_empty'
    || category === 'model_unsupported'
    || (category === 'invalid_channel' && isGenericBadResponseStatusWrapper(errorText))
    || (category === 'invalid_channel' && /无权访问\s*.+\s*分组|no\s+access\s+to\s+group|no\s+tool\s+output\s+found\s+for\s+function\s+call/i.test(errorText));
}

function applyRuntimeHealthFailure(state: SiteRuntimeHealthState, context: SiteRuntimeFailureContext = {}, nowMs = Date.now()): void {
  state.penaltyScore += resolveSiteRuntimeFailurePenalty(context);
  const immediateBreakerMs = Math.max(
    resolveImmediateModelBreakerDurationMs(context),
    resolveImmediateSiteRuntimeBreakerDurationMs(context),
  );
  const retryAfterMs = resolveRetryAfterMsFromContext(context, nowMs);
  if (immediateBreakerMs > 0 && shouldOpenImmediateRuntimeBreaker(context)) {
    state.breakerLevel = Math.min(
      SITE_RUNTIME_BREAKER_LEVELS_MS.length - 1,
      state.breakerLevel + 1,
    );
    state.breakerUntilMs = nowMs + Math.max(immediateBreakerMs, retryAfterMs ?? 0);
    state.transientFailureStreak = 0;
    state.lastTransientFailureAtMs = null;
    state.lastFailureAtMs = nowMs;
    return;
  }

  if (isTransientSiteRuntimeFailure(context)) {
    const lastTransientFailureAtMs = state.lastTransientFailureAtMs;
    const shouldContinueStreak = (
      typeof lastTransientFailureAtMs === 'number'
      && (nowMs - lastTransientFailureAtMs) <= SITE_TRANSIENT_STREAK_WINDOW_MS
    );
    state.transientFailureStreak = shouldContinueStreak
      ? state.transientFailureStreak + 1
      : 1;
    state.lastTransientFailureAtMs = nowMs;
    if (state.transientFailureStreak >= SITE_RUNTIME_BREAKER_STREAK_THRESHOLD) {
      state.breakerLevel = Math.min(state.breakerLevel + 1, SITE_RUNTIME_BREAKER_LEVELS_MS.length - 1);
      const breakerMs = resolveSiteRuntimeBreakerMs(state.breakerLevel);
      const effectiveBreakerMs = Math.max(breakerMs, retryAfterMs ?? 0);
      state.breakerUntilMs = effectiveBreakerMs > 0 ? nowMs + effectiveBreakerMs : null;
      state.transientFailureStreak = 0;
    }
  } else {
    state.transientFailureStreak = 0;
    state.lastTransientFailureAtMs = null;
  }
  if (retryAfterMs != null && retryAfterMs > 0) {
    state.breakerUntilMs = Math.max(state.breakerUntilMs ?? 0, nowMs + retryAfterMs);
  }
  state.lastFailureAtMs = nowMs;
}

function applyRuntimeHealthSuccess(state: SiteRuntimeHealthState, latencyMs: number, nowMs = Date.now()): void {
  state.penaltyScore = Math.max(0, state.penaltyScore * 0.2 - 0.3);
  state.transientFailureStreak = 0;
  state.lastTransientFailureAtMs = null;
  state.breakerLevel = 0;
  state.breakerUntilMs = null;
  state.lastSuccessAtMs = nowMs;
  const normalizedLatencyMs = Math.max(0, Math.trunc(latencyMs));
  state.latencyEmaMs = state.latencyEmaMs == null
    ? normalizedLatencyMs
    : (state.latencyEmaMs * (1 - SITE_RUNTIME_LATENCY_EMA_ALPHA))
      + (normalizedLatencyMs * SITE_RUNTIME_LATENCY_EMA_ALPHA);
  if (normalizedLatencyMs >= config.slowSuccessLatencyThresholdMs) {
    state.penaltyScore += config.slowSuccessPenaltyScore;
  }
}

function shouldPersistSiteRuntimeHealthState(state: SiteRuntimeHealthState, nowMs = Date.now()): boolean {
  const lastTouchedAtMs = Math.max(
    state.lastUpdatedAtMs,
    state.lastFailureAtMs ?? 0,
    state.lastSuccessAtMs ?? 0,
    state.lastTransientFailureAtMs ?? 0,
  );
  if ((nowMs - lastTouchedAtMs) > SITE_RUNTIME_HEALTH_PERSIST_STALE_TTL_MS) {
    return false;
  }

  if (isRuntimeHealthBreakerOpen(state, nowMs)) return true;
  if (getDecayedSiteRuntimePenalty(state, nowMs) >= SITE_RUNTIME_HEALTH_PERSIST_MIN_PENALTY) return true;
  if ((state.latencyEmaMs ?? 0) > 0) return true;
  return (nowMs - lastTouchedAtMs) <= SITE_RUNTIME_HEALTH_PERSIST_IDLE_TTL_MS;
}

function buildSiteRuntimeHealthPersistencePayload(nowMs = Date.now()): SiteRuntimeHealthPersistencePayload {
  const globalBySiteId: Record<string, SiteRuntimeHealthState> = {};
  const modelBySiteId: Record<string, Record<string, SiteRuntimeHealthState>> = {};

  for (const [siteId, state] of siteRuntimeHealthStates.entries()) {
    if (!shouldPersistSiteRuntimeHealthState(state, nowMs)) continue;
    globalBySiteId[String(siteId)] = cloneSiteRuntimeHealthState(state);
  }

  for (const [siteId, modelStates] of siteModelRuntimeHealthStates.entries()) {
    const persistedModels: Record<string, SiteRuntimeHealthState> = {};
    for (const [modelKey, state] of modelStates.entries()) {
      if (!shouldPersistSiteRuntimeHealthState(state, nowMs)) continue;
      persistedModels[modelKey] = cloneSiteRuntimeHealthState(state);
    }
    if (Object.keys(persistedModels).length > 0) {
      modelBySiteId[String(siteId)] = persistedModels;
    }
  }

  return {
    version: 1,
    savedAtMs: nowMs,
    globalBySiteId,
    modelBySiteId,
  };
}

async function persistSiteRuntimeHealthState(): Promise<void> {
  if (siteRuntimeHealthPersistInFlight) {
    await siteRuntimeHealthPersistInFlight;
    return;
  }
  const persistTask = (async () => {
    const payload = buildSiteRuntimeHealthPersistencePayload();
    await upsertSetting(SITE_RUNTIME_HEALTH_SETTING_KEY, payload);
  })();
  siteRuntimeHealthPersistInFlight = persistTask.finally(() => {
    if (siteRuntimeHealthPersistInFlight === persistTask) {
      siteRuntimeHealthPersistInFlight = null;
    }
  });
  await siteRuntimeHealthPersistInFlight;
}

function scheduleSiteRuntimeHealthPersistence(): void {
  if (siteRuntimeHealthSaveTimer) return;
  siteRuntimeHealthSaveTimer = setTimeout(() => {
    siteRuntimeHealthSaveTimer = null;
    void persistSiteRuntimeHealthState();
  }, SITE_RUNTIME_HEALTH_PERSIST_DEBOUNCE_MS);
}

async function loadSiteRuntimeHealthStateFromSettings(): Promise<void> {
  siteRuntimeHealthStates.clear();
  siteModelRuntimeHealthStates.clear();

  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, SITE_RUNTIME_HEALTH_SETTING_KEY))
    .get();
  if (!row?.value) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;

  const globalBySiteId = isRecord(parsed.globalBySiteId) ? parsed.globalBySiteId : {};
  for (const [siteIdKey, stateRaw] of Object.entries(globalBySiteId)) {
    const siteId = Number(siteIdKey);
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    const state = hydrateSiteRuntimeHealthState(stateRaw);
    if (!state) continue;
    siteRuntimeHealthStates.set(siteId, state);
  }

  const modelBySiteId = isRecord(parsed.modelBySiteId) ? parsed.modelBySiteId : {};
  for (const [siteIdKey, modelStatesRaw] of Object.entries(modelBySiteId)) {
    const siteId = Number(siteIdKey);
    if (!Number.isFinite(siteId) || siteId <= 0 || !isRecord(modelStatesRaw)) continue;
    const hydratedModelStates = new Map<string, SiteRuntimeHealthState>();
    for (const [rawModelKey, stateRaw] of Object.entries(modelStatesRaw)) {
      const modelKey = normalizeModelAlias(rawModelKey);
      if (!modelKey) continue;
      const state = hydrateSiteRuntimeHealthState(stateRaw);
      if (!state) continue;
      hydratedModelStates.set(modelKey, state);
    }
    if (hydratedModelStates.size > 0) {
      siteModelRuntimeHealthStates.set(siteId, hydratedModelStates);
    }
  }
}

async function ensureSiteRuntimeHealthStateLoaded(): Promise<void> {
  if (siteRuntimeHealthLoaded) return;
  if (!siteRuntimeHealthLoadPromise) {
    siteRuntimeHealthLoadPromise = (async () => {
      try {
        await loadSiteRuntimeHealthStateFromSettings();
      } finally {
        siteRuntimeHealthLoaded = true;
      }
    })();
  }
  await siteRuntimeHealthLoadPromise;
}

function resolveAccountRateLimitCapacity(state?: AccountRoutingState | null): number {
  const successEma = state?.successEma ?? 0.5;
  const latencyEmaMs = state?.latencyEmaMs;
  if (successEma >= 0.85 && (latencyEmaMs == null || latencyEmaMs <= 3_500)) return 6;
  if (successEma >= 0.7 && (latencyEmaMs == null || latencyEmaMs <= 6_000)) return 4;
  return 2;
}

function resolveAccountRateLimitRefillPerSec(state?: AccountRoutingState | null): number {
  const successEma = state?.successEma ?? 0.5;
  const latencyEmaMs = state?.latencyEmaMs;
  const consecutiveFailures = state?.consecutiveFailures ?? 0;
  if (consecutiveFailures >= 2) return 0.15;
  if (successEma >= 0.85 && (latencyEmaMs == null || latencyEmaMs <= 3_500)) return 1.2;
  if (successEma >= 0.7 && (latencyEmaMs == null || latencyEmaMs <= 6_000)) return 0.6;
  return 0.25;
}

function getOrCreateAccountRateBudgetState(accountId: number, nowMs = Date.now()): AccountRateBudgetState {
  const existing = accountRateBudgetStates.get(accountId);
  if (existing) {
    existing.updatedAtMs = Math.max(existing.updatedAtMs, nowMs);
    return existing;
  }

  const routingState = accountRoutingStates.get(accountId) ?? null;
  const capacity = resolveAccountRateLimitCapacity(routingState);
  const refillPerSec = resolveAccountRateLimitRefillPerSec(routingState);
  const state: AccountRateBudgetState = {
    tokens: capacity,
    capacity,
    refillPerSec,
    lastRefillAtMs: nowMs,
    lastGrantedAtMs: null,
    denyUntilMs: null,
    updatedAtMs: nowMs,
  };
  accountRateBudgetStates.set(accountId, state);
  return state;
}

function refillAccountRateBudget(state: AccountRateBudgetState, nowMs = Date.now()): void {
  const elapsedMs = Math.max(0, nowMs - state.lastRefillAtMs);
  if (elapsedMs > 0) {
    const refillTokens = (elapsedMs / 1000) * state.refillPerSec;
    state.tokens = clampNumber(state.tokens + refillTokens, 0, state.capacity);
    state.lastRefillAtMs = nowMs;
  }
  if (state.denyUntilMs != null && state.denyUntilMs <= nowMs) {
    state.denyUntilMs = null;
  }
  state.updatedAtMs = nowMs;
}

function syncAccountRateBudgetConfig(accountId: number, nowMs = Date.now()): AccountRateBudgetState {
  const routingState = accountRoutingStates.get(accountId) ?? null;
  const state = getOrCreateAccountRateBudgetState(accountId, nowMs);
  refillAccountRateBudget(state, nowMs);
  state.capacity = resolveAccountRateLimitCapacity(routingState);
  state.refillPerSec = resolveAccountRateLimitRefillPerSec(routingState);
  state.tokens = clampNumber(state.tokens, 0, state.capacity);
  state.updatedAtMs = nowMs;
  return state;
}

function shouldPersistAccountRoutingState(state: AccountRoutingState, nowMs = Date.now()): boolean {
  const lastTouchedAtMs = Math.max(
    state.updatedAtMs,
    state.lastSuccessAtMs ?? 0,
    state.lastFailureAtMs ?? 0,
  );
  if ((nowMs - lastTouchedAtMs) > ACCOUNT_ROUTING_PERSIST_STALE_TTL_MS) return false;
  if (state.consecutiveFailures > 0) return true;
  if ((state.latencyEmaMs ?? 0) > 0) return true;
  return (nowMs - lastTouchedAtMs) <= ACCOUNT_ROUTING_PERSIST_IDLE_TTL_MS;
}

function shouldPersistAccountRateBudgetState(state: AccountRateBudgetState, nowMs = Date.now()): boolean {
  const lastTouchedAtMs = Math.max(
    state.updatedAtMs,
    state.lastGrantedAtMs ?? 0,
    state.lastRefillAtMs,
    state.denyUntilMs ?? 0,
  );
  if ((nowMs - lastTouchedAtMs) > ACCOUNT_ROUTING_PERSIST_IDLE_TTL_MS) return false;
  return state.tokens < state.capacity || (state.denyUntilMs != null && state.denyUntilMs > nowMs);
}

function buildAccountRoutingHealthPersistencePayload(nowMs = Date.now()): AccountRoutingHealthPersistencePayload {
  const byAccountId: Record<string, AccountRoutingState> = {};
  for (const [accountId, state] of accountRoutingStates.entries()) {
    if (!shouldPersistAccountRoutingState(state, nowMs)) continue;
    byAccountId[String(accountId)] = cloneAccountRoutingState(state);
  }
  return {
    version: 1,
    savedAtMs: nowMs,
    byAccountId,
  };
}

function buildAccountRoutingBudgetPersistencePayload(nowMs = Date.now()): AccountRoutingBudgetPersistencePayload {
  const byAccountId: Record<string, {
    budget: AccountRateBudgetState;
    inflightLeases: AccountSelectionLease[];
  }> = {};
  pruneAccountSelectionLeases(nowMs);
  for (const [accountId, state] of accountRateBudgetStates.entries()) {
    if (!shouldPersistAccountRateBudgetState(state, nowMs) && getAccountSelectionLeases(accountId, nowMs).length === 0) continue;
    byAccountId[String(accountId)] = {
      budget: cloneAccountRateBudgetState(state),
      inflightLeases: getAccountSelectionLeases(accountId, nowMs),
    };
  }
  return {
    version: 1,
    savedAtMs: nowMs,
    byAccountId,
  };
}

function buildAccountStickyBindingPersistencePayload(nowMs = Date.now()): AccountStickyBindingPersistencePayload {
  const byStickyKeyHash: Record<string, StickySessionBinding> = {};
  pruneStickySessionBindings(nowMs);
  for (const [stickyKeyHash, binding] of stickySessionBindings.entries()) {
    if (binding.expiresAtMs <= nowMs) continue;
    byStickyKeyHash[stickyKeyHash] = {
      accountId: binding.accountId,
      expiresAtMs: binding.expiresAtMs,
      lastUsedAtMs: binding.lastUsedAtMs,
    };
  }
  return {
    version: 1,
    savedAtMs: nowMs,
    byStickyKeyHash,
  };
}

async function persistAccountRuntimeState(): Promise<void> {
  if (accountRuntimePersistInFlight) {
    await accountRuntimePersistInFlight;
    return;
  }
  const persistTask = (async () => {
    const nowMs = Date.now();
    await Promise.all([
      upsertSetting(ACCOUNT_ROUTING_HEALTH_SETTING_KEY, buildAccountRoutingHealthPersistencePayload(nowMs)),
      upsertSetting(ACCOUNT_ROUTING_BUDGET_SETTING_KEY, buildAccountRoutingBudgetPersistencePayload(nowMs)),
      upsertSetting(ACCOUNT_ROUTING_STICKY_SETTING_KEY, buildAccountStickyBindingPersistencePayload(nowMs)),
    ]);
    accountRuntimeLastSyncedAtMs = nowMs;
  })();
  accountRuntimePersistInFlight = persistTask.finally(() => {
    if (accountRuntimePersistInFlight === persistTask) {
      accountRuntimePersistInFlight = null;
    }
  });
  await accountRuntimePersistInFlight;
}

function scheduleAccountRuntimePersistence(): void {
  if (accountRuntimeSaveTimer) return;
  accountRuntimeSaveTimer = setTimeout(() => {
    accountRuntimeSaveTimer = null;
    void persistAccountRuntimeState();
  }, ACCOUNT_ROUTING_PERSIST_DEBOUNCE_MS);
}

async function loadAccountRuntimeStateFromSettings(force = false): Promise<void> {
  const nowMs = Date.now();
  if (!force && accountRuntimeLoaded && (nowMs - accountRuntimeLastSyncedAtMs) < ACCOUNT_ROUTING_SYNC_INTERVAL_MS) {
    return;
  }

  const [healthRow, budgetRow, stickyRow] = await Promise.all([
    db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, ACCOUNT_ROUTING_HEALTH_SETTING_KEY)).get(),
    db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, ACCOUNT_ROUTING_BUDGET_SETTING_KEY)).get(),
    db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, ACCOUNT_ROUTING_STICKY_SETTING_KEY)).get(),
  ]);

  const parsedHealth = (() => {
    try { return healthRow?.value ? JSON.parse(healthRow.value) : null; } catch { return null; }
  })();
  if (isRecord(parsedHealth) && isRecord(parsedHealth.byAccountId)) {
    for (const [accountIdKey, stateRaw] of Object.entries(parsedHealth.byAccountId)) {
      const accountId = Number(accountIdKey);
      if (!Number.isFinite(accountId) || accountId <= 0) continue;
      const state = hydrateAccountRoutingState(stateRaw);
      if (!state) continue;
      const existing = accountRoutingStates.get(accountId);
      if (!existing || state.updatedAtMs >= existing.updatedAtMs) {
        accountRoutingStates.set(accountId, state);
      }
    }
  }

  const parsedBudget = (() => {
    try { return budgetRow?.value ? JSON.parse(budgetRow.value) : null; } catch { return null; }
  })();
  if (isRecord(parsedBudget) && isRecord(parsedBudget.byAccountId)) {
    for (const [accountIdKey, itemRaw] of Object.entries(parsedBudget.byAccountId)) {
      const accountId = Number(accountIdKey);
      if (!Number.isFinite(accountId) || accountId <= 0 || !isRecord(itemRaw)) continue;
      const budget = hydrateAccountRateBudgetState(itemRaw.budget);
      if (budget) {
        const existing = accountRateBudgetStates.get(accountId);
        if (!existing || budget.updatedAtMs >= existing.updatedAtMs) {
          accountRateBudgetStates.set(accountId, budget);
        }
      }
      const inflightLeases = Array.isArray(itemRaw.inflightLeases)
        ? itemRaw.inflightLeases
          .map((leaseRaw) => isRecord(leaseRaw) ? { expiresAtMs: readNullableTimestamp(leaseRaw.expiresAtMs) ?? 0 } : null)
          .filter((lease): lease is AccountSelectionLease => !!lease && lease.expiresAtMs > nowMs)
        : [];
      if (inflightLeases.length > 0) {
        const existingLeases = getAccountSelectionLeases(accountId, nowMs);
        accountSelectionLeases.set(accountId, [...existingLeases, ...inflightLeases]
          .sort((left, right) => left.expiresAtMs - right.expiresAtMs)
          .slice(-8));
      }
    }
  }

  const parsedSticky = (() => {
    try { return stickyRow?.value ? JSON.parse(stickyRow.value) : null; } catch { return null; }
  })();
  if (isRecord(parsedSticky) && isRecord(parsedSticky.byStickyKeyHash)) {
    for (const [stickyKeyHash, bindingRaw] of Object.entries(parsedSticky.byStickyKeyHash)) {
      const binding = hydrateStickySessionBinding(bindingRaw);
      if (!binding || binding.expiresAtMs <= nowMs) continue;
      const existing = stickySessionBindings.get(stickyKeyHash);
      if (
        !existing
        || binding.lastUsedAtMs >= existing.lastUsedAtMs
        || binding.expiresAtMs >= existing.expiresAtMs
      ) {
        stickySessionBindings.set(stickyKeyHash, binding);
      }
    }
  }

  pruneAccountRoutingStates(nowMs);
  pruneAccountSelectionLeases(nowMs);
  pruneStickySessionBindings(nowMs);
  accountRuntimeLoaded = true;
  accountRuntimeLastSyncedAtMs = nowMs;
}

async function ensureAccountRuntimeStateLoaded(): Promise<void> {
  if (accountRuntimeLoaded && (Date.now() - accountRuntimeLastSyncedAtMs) < ACCOUNT_ROUTING_SYNC_INTERVAL_MS) return;
  if (!accountRuntimeLoadPromise) {
    accountRuntimeLoadPromise = (async () => {
      try {
        await loadAccountRuntimeStateFromSettings(!accountRuntimeLoaded);
      } finally {
        accountRuntimeLoadPromise = null;
      }
    })();
  }
  await accountRuntimeLoadPromise;
}

let circuitPersistInjected = false;

async function ensureRoutingRuntimeStateLoaded(): Promise<void> {
  await ensureSiteRuntimeHealthStateLoaded();
  await ensureAccountRuntimeStateLoaded();
  if (!circuitPersistInjected) {
    circuitPersistInjected = true;
    injectCircuitPersistFns(
      (key, value) => upsertSetting(key, value),
      async (key) => {
        const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
        if (!row) return null;
        try { return JSON.parse(row.value); } catch { return null; }
      },
    );
    await loadPersistedModelCircuits();
  }
}

function recordSiteRuntimeFailure(siteId: number, context: SiteRuntimeFailureContext = {}, nowMs = Date.now()): void {
  let changed = false;
  if (shouldApplySiteWideFailureTracking(context)) {
    applyRuntimeHealthFailure(getOrCreateSiteRuntimeHealthState(siteId, nowMs), context, nowMs);
    changed = true;
  }
  if (shouldApplySiteModelFailureTracking(context)) {
    const modelState = getOrCreateSiteModelRuntimeHealthState(siteId, context.modelName, nowMs);
    if (modelState) {
      applyRuntimeHealthFailure(modelState, context, nowMs);
      changed = true;
    }
  }
  if (changed) {
    scheduleSiteRuntimeHealthPersistence();
  }
}

function recordSiteRuntimeSuccess(siteId: number, latencyMs: number, modelName?: string | null, nowMs = Date.now()): void {
  applyRuntimeHealthSuccess(getOrCreateSiteRuntimeHealthState(siteId, nowMs), latencyMs, nowMs);
  const modelState = getOrCreateSiteModelRuntimeHealthState(siteId, modelName, nowMs);
  if (modelState) {
    applyRuntimeHealthSuccess(modelState, latencyMs, nowMs);
  }
  scheduleSiteRuntimeHealthPersistence();
}

export function resetSiteRuntimeHealthState(): void {
  siteRuntimeHealthStates.clear();
  siteModelRuntimeHealthStates.clear();
  accountRoutingStates.clear();
  accountRateBudgetStates.clear();
  accountSelectionLeases.clear();
  stickySessionBindings.clear();
  stickySessionKeyByChannel.clear();
  siteRuntimeHealthLoaded = false;
  siteRuntimeHealthLoadPromise = null;
  if (siteRuntimeHealthSaveTimer) {
    clearTimeout(siteRuntimeHealthSaveTimer);
    siteRuntimeHealthSaveTimer = null;
  }
  siteRuntimeHealthPersistInFlight = null;
  accountRuntimeLoaded = false;
  accountRuntimeLoadPromise = null;
  if (accountRuntimeSaveTimer) {
    clearTimeout(accountRuntimeSaveTimer);
    accountRuntimeSaveTimer = null;
  }
  accountRuntimePersistInFlight = null;
  accountRuntimeLastSyncedAtMs = 0;
}

export async function flushSiteRuntimeHealthPersistence(): Promise<void> {
  if (siteRuntimeHealthSaveTimer) {
    clearTimeout(siteRuntimeHealthSaveTimer);
    siteRuntimeHealthSaveTimer = null;
    await persistSiteRuntimeHealthState();
  } else if (siteRuntimeHealthPersistInFlight) {
    await siteRuntimeHealthPersistInFlight;
  }
  if (accountRuntimeSaveTimer) {
    clearTimeout(accountRuntimeSaveTimer);
    accountRuntimeSaveTimer = null;
    await persistAccountRuntimeState();
  } else if (accountRuntimePersistInFlight) {
    await accountRuntimePersistInFlight;
  }
}

export async function clearRoutingRuntimeState(): Promise<{
  updatedChannels: number;
  clearedModelCircuits: number;
  clearedPersistedSiteRuntimeState: boolean;
  clearedAccountRuntimeState: boolean;
}> {
  await ensureRoutingRuntimeStateLoaded();

  const updatedChannels = (await db.update(schema.routeChannels).set({
    lastFailAt: null,
    consecutiveFailCount: 0,
    cooldownLevel: 0,
    cooldownUntil: null,
  }).run()).changes;

  const clearedPersistedSiteRuntimeState = (await db.delete(schema.settings)
    .where(eq(schema.settings.key, SITE_RUNTIME_HEALTH_SETTING_KEY))
    .run()).changes > 0;
  await db.delete(schema.settings)
    .where(inArray(schema.settings.key, [
      ACCOUNT_ROUTING_HEALTH_SETTING_KEY,
      ACCOUNT_ROUTING_BUDGET_SETTING_KEY,
      ACCOUNT_ROUTING_STICKY_SETTING_KEY,
    ]))
    .run();

  resetSiteRuntimeHealthState();
  const clearedModelCircuits = resetAllModelCircuits();
  invalidateTokenRouterCache();

  return {
    updatedChannels,
    clearedModelCircuits,
    clearedPersistedSiteRuntimeState,
    clearedAccountRuntimeState: true,
  };
}

export async function listSiteRuntimeHealthSnapshots(nowMs = Date.now()): Promise<SiteRuntimeHealthSnapshotEntry[]> {
  await ensureRoutingRuntimeStateLoaded();
  pruneAccountRoutingStates(nowMs);
  const entries: SiteRuntimeHealthSnapshotEntry[] = [];

  for (const [siteId, state] of siteRuntimeHealthStates.entries()) {
    entries.push({
      siteId,
      modelName: null,
      scope: 'global',
      penaltyScore: state.penaltyScore,
      latencyEmaMs: state.latencyEmaMs,
      transientFailureStreak: state.transientFailureStreak,
      breakerLevel: state.breakerLevel,
      breakerUntilMs: state.breakerUntilMs,
      lastUpdatedAtMs: state.lastUpdatedAtMs,
      lastFailureAtMs: state.lastFailureAtMs,
      lastSuccessAtMs: state.lastSuccessAtMs,
      multiplier: getRuntimeHealthMultiplier(state, nowMs),
      breakerOpen: isRuntimeHealthBreakerOpen(state, nowMs),
    });
  }

  for (const [siteId, models] of siteModelRuntimeHealthStates.entries()) {
    for (const [modelName, state] of models.entries()) {
      entries.push({
        siteId,
        modelName,
        scope: 'model',
        penaltyScore: state.penaltyScore,
        latencyEmaMs: state.latencyEmaMs,
        transientFailureStreak: state.transientFailureStreak,
        breakerLevel: state.breakerLevel,
        breakerUntilMs: state.breakerUntilMs,
        lastUpdatedAtMs: state.lastUpdatedAtMs,
        lastFailureAtMs: state.lastFailureAtMs,
        lastSuccessAtMs: state.lastSuccessAtMs,
        multiplier: getRuntimeHealthMultiplier(state, nowMs),
        breakerOpen: isRuntimeHealthBreakerOpen(state, nowMs),
      });
    }
  }

  entries.sort((left, right) => (
    Number(right.breakerOpen) - Number(left.breakerOpen)
    || left.multiplier - right.multiplier
    || right.penaltyScore - left.penaltyScore
    || left.siteId - right.siteId
    || (left.modelName || '').localeCompare((right.modelName || ''), undefined, { sensitivity: 'base' })
  ));

  return entries;
}

export async function listAccountRoutingRuntimeSnapshots(nowMs = Date.now()): Promise<AccountRuntimeSnapshotEntry[]> {
  await ensureRoutingRuntimeStateLoaded();
  pruneAccountRoutingStates(nowMs);
  pruneAccountSelectionLeases(nowMs);
  pruneStickySessionBindings(nowMs);

  const accountSiteRows = await db.select({
    accountId: schema.accounts.id,
    siteId: schema.accounts.siteId,
  }).from(schema.accounts).all();
  const siteIdByAccountId = new Map<number, number>();
  for (const row of accountSiteRows) {
    siteIdByAccountId.set(row.accountId, row.siteId);
  }

  const stickyActiveCountByAccountId = new Map<number, number>();
  for (const binding of stickySessionBindings.values()) {
    stickyActiveCountByAccountId.set(
      binding.accountId,
      (stickyActiveCountByAccountId.get(binding.accountId) || 0) + 1,
    );
  }

  const entries: AccountRuntimeSnapshotEntry[] = [];
  const accountIds = new Set<number>([
    ...accountRoutingStates.keys(),
    ...accountRateBudgetStates.keys(),
    ...accountSelectionLeases.keys(),
  ]);
  for (const accountId of accountIds) {
    const state = accountRoutingStates.get(accountId) ?? {
      successEma: 0.5,
      latencyEmaMs: null,
      lastSuccessAtMs: null,
      lastFailureAtMs: null,
      consecutiveFailures: 0,
      updatedAtMs: nowMs,
    };
    const budgetState = syncAccountRateBudgetConfig(accountId, nowMs);
    entries.push({
      accountId,
      siteId: siteIdByAccountId.get(accountId) ?? 0,
      successEma: state.successEma,
      latencyEmaMs: state.latencyEmaMs,
      inflightCount: getAccountSelectionLeases(accountId, nowMs).length,
      concurrencyBudget: Math.max(1, state.successEma >= 0.75 && (state.latencyEmaMs == null || state.latencyEmaMs <= 6_000) && state.consecutiveFailures < 2 ? 2 : 1),
      rateLimitCapacity: budgetState.capacity,
      rateLimitTokens: Number(budgetState.tokens.toFixed(3)),
      rateLimitRefillPerSec: budgetState.refillPerSec,
      rateLimitedUntilMs: budgetState.denyUntilMs,
      rateLimited: budgetState.denyUntilMs != null && budgetState.denyUntilMs > nowMs,
      stickyActiveCount: stickyActiveCountByAccountId.get(accountId) || 0,
      lastSuccessAtMs: state.lastSuccessAtMs,
      lastFailureAtMs: state.lastFailureAtMs,
      consecutiveFailures: state.consecutiveFailures,
    });
  }

  entries.sort((left, right) => (
    right.stickyActiveCount - left.stickyActiveCount
    || right.inflightCount - left.inflightCount
    || left.successEma - right.successEma
    || left.accountId - right.accountId
  ));
  return entries;
}

export function getSiteRuntimeHealthMultiplier(siteId: number, nowMs = Date.now()): number {
  const state = siteRuntimeHealthStates.get(siteId);
  return getRuntimeHealthMultiplier(state, nowMs);
}

export function isSiteRuntimeBreakerOpen(siteId: number, nowMs = Date.now()): boolean {
  const state = siteRuntimeHealthStates.get(siteId);
  return isRuntimeHealthBreakerOpen(state, nowMs);
}

export function filterSiteRuntimeBrokenCandidates<T extends { site: { id: number } }>(
  candidates: T[],
  nowMs = Date.now(),
): T[] {
  if (candidates.length <= 1) return candidates;
  const healthy = candidates.filter((candidate) => !isSiteRuntimeBreakerOpen(candidate.site.id, nowMs));
  return healthy.length > 0 ? healthy : candidates;
}

function buildRuntimeBreakerReason(details: SiteRuntimeHealthDetails): string {
  if (details.globalBreakerOpen && details.modelBreakerOpen) {
    return '站点熔断中，模型熔断中，优先避让';
  }
  if (details.globalBreakerOpen) {
    return '站点熔断中，优先避让';
  }
  if (details.modelBreakerOpen) {
    return '模型熔断中，优先避让';
  }
  return '运行时熔断中，优先避让';
}

function buildRuntimeCircuitStatus(details: SiteRuntimeHealthDetails): {
  state: 'closed' | 'open';
  isOpen: boolean;
  reason: string;
} {
  const isOpen = details.globalBreakerOpen || details.modelBreakerOpen;
  return {
    state: isOpen ? 'open' : 'closed',
    isOpen,
    reason: isOpen ? buildRuntimeBreakerReason(details) : '运行时熔断关闭',
  };
}

function filterSiteRuntimeBrokenCandidatesByModel(
  candidates: RouteChannelCandidate[],
  modelName: string | ((candidate: RouteChannelCandidate) => string),
  nowMs = Date.now(),
): {
  candidates: RouteChannelCandidate[];
  avoided: Array<{ candidate: RouteChannelCandidate; reason: string }>;
} {
  if (candidates.length === 0) {
    return {
      candidates,
      avoided: [],
    };
  }

  const resolveModelName = typeof modelName === 'function'
    ? modelName
    : (() => modelName);
  const avoided: Array<{ candidate: RouteChannelCandidate; reason: string }> = [];
  const healthy = candidates.filter((candidate) => {
    const details = getSiteRuntimeHealthDetails(candidate.site.id, resolveModelName(candidate), nowMs);
    const blocked = details.globalBreakerOpen || details.modelBreakerOpen;
    if (blocked) {
      avoided.push({
        candidate,
        reason: buildRuntimeBreakerReason(details),
      });
    }
    return !blocked;
  });

  return healthy.length > 0
    ? {
      candidates: healthy,
      avoided,
    }
    : {
      candidates,
      avoided,
    };
}

type RouteMode = 'pattern' | 'explicit_group';
type RouteRow = typeof schema.tokenRoutes.$inferSelect & {
  routeMode: RouteMode;
  sourceRouteIds: number[];
};
type ChannelRow = typeof schema.routeChannels.$inferSelect;
type RouteChannelIdRow = { id: number };
type CredentialScopedChannelRow = {
  channelId: number;
  accountId: number;
  extraConfig: string | null;
  tokenId: number | null;
};
type JoinedRouteMatchRow = {
  route_channels: typeof schema.routeChannels.$inferSelect;
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
  account_tokens: typeof schema.accountTokens.$inferSelect | null;
};

type RouteCacheSnapshot = {
  loadedAt: number;
  routes: RouteRow[];
};

type RouteMatchCacheSnapshot = {
  loadedAt: number;
  match: RouteMatch;
};

let routeCacheSnapshot: RouteCacheSnapshot = {
  loadedAt: 0,
  routes: [],
};

const routeMatchCache = new Map<number, RouteMatchCacheSnapshot>();

function pruneChannelSelectionLeases(nowMs = Date.now()): void {
  for (const [channelId, lease] of channelSelectionLeases.entries()) {
    if (lease.expiresAtMs <= nowMs) {
      channelSelectionLeases.delete(channelId);
    }
  }
}

function pruneAccountSelectionLeases(nowMs = Date.now()): void {
  for (const [accountId, leases] of accountSelectionLeases.entries()) {
    const activeLeases = leases.filter((lease) => lease.expiresAtMs > nowMs);
    if (activeLeases.length === 0) {
      accountSelectionLeases.delete(accountId);
      continue;
    }
    accountSelectionLeases.set(accountId, activeLeases);
  }
}

function getAccountSelectionLeases(accountId: number, nowMs = Date.now()): AccountSelectionLease[] {
  pruneAccountSelectionLeases(nowMs);
  return accountSelectionLeases.get(accountId) ?? [];
}

function getAccountSelectionLeaseUntil(accountId: number, nowMs = Date.now()): string | null {
  const latestExpiresAtMs = getAccountSelectionLeases(accountId, nowMs)
    .reduce<number | null>((latest, lease) => {
      if (latest == null || lease.expiresAtMs > latest) return lease.expiresAtMs;
      return latest;
    }, null);
  return latestExpiresAtMs ? new Date(latestExpiresAtMs).toISOString() : null;
}

function getOrCreateAccountRoutingState(accountId: number, nowMs = Date.now()): AccountRoutingState {
  const existing = accountRoutingStates.get(accountId);
  if (existing) {
    existing.updatedAtMs = Math.max(existing.updatedAtMs, nowMs);
    return existing;
  }

  const state: AccountRoutingState = {
    successEma: 0.5,
    latencyEmaMs: null,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    consecutiveFailures: 0,
    updatedAtMs: nowMs,
  };
  accountRoutingStates.set(accountId, state);
  scheduleAccountRuntimePersistence();
  return state;
}

function pruneAccountRoutingStates(nowMs = Date.now()): void {
  for (const [accountId, state] of accountRoutingStates.entries()) {
    const lastTouchedAtMs = Math.max(
      state.updatedAtMs,
      state.lastSuccessAtMs ?? 0,
      state.lastFailureAtMs ?? 0,
    );
    if ((nowMs - lastTouchedAtMs) > ACCOUNT_ROUTING_STATE_TTL_MS) {
      accountRoutingStates.delete(accountId);
      accountRateBudgetStates.delete(accountId);
      accountSelectionLeases.delete(accountId);
    }
  }
}

function pruneStickySessionBindings(nowMs = Date.now()): void {
  for (const [stickyKeyHash, binding] of stickySessionBindings.entries()) {
    if (binding.expiresAtMs <= nowMs) {
      stickySessionBindings.delete(stickyKeyHash);
    }
  }
  for (const [channelId, stickyKeyHash] of stickySessionKeyByChannel.entries()) {
    if (!stickySessionBindings.has(stickyKeyHash)) {
      stickySessionKeyByChannel.delete(channelId);
    }
  }
}

function getStickySessionBinding(stickySessionKey: string | null | undefined, nowMs = Date.now()): StickySessionBinding | null {
  const normalizedKey = typeof stickySessionKey === 'string' ? stickySessionKey.trim() : '';
  if (!normalizedKey) return null;
  pruneStickySessionBindings(nowMs);
  return stickySessionBindings.get(hashStickySessionKey(normalizedKey)) ?? null;
}

function getAccountConcurrencyBudget(candidate: RouteChannelCandidate, state?: AccountRoutingState | null): number {
  const successEma = state?.successEma ?? 0.5;
  const latencyEmaMs = state?.latencyEmaMs;
  const consecutiveFailures = state?.consecutiveFailures ?? 0;
  const isExplicitToken = isExplicitTokenChannel(candidate);

  if (!isExplicitToken) return 1;
  if (consecutiveFailures >= 2) return 1;
  if (successEma >= 0.75 && (latencyEmaMs == null || latencyEmaMs <= 6_000)) return 2;
  return 1;
}

function buildAccountRateLimitReason(item: {
  inflightCount: number;
  concurrencyBudget: number;
  leaseUntil: string;
  rateLimitedUntil: string | null;
  budgetTokens: number;
  budgetCapacity: number;
  budgetRefillPerSec: number;
}, nowMs: number): string {
  if (item.rateLimitedUntil) {
    return `账号速率受限，优先避让（令牌=${item.budgetTokens.toFixed(2)}/${item.budgetCapacity}，${resolveLeaseAvoidWindowSec(item.rateLimitedUntil, nowMs)} 秒后恢复）`;
  }
  if (item.budgetTokens < 1 && item.inflightCount < item.concurrencyBudget) {
    const refillPerSec = Math.max(item.budgetRefillPerSec, 0.01);
    const retryAfterSec = Math.max(1, Math.ceil((1 - item.budgetTokens) / refillPerSec));
    return `账号速率预算不足，优先避让（令牌=${item.budgetTokens.toFixed(2)}/${item.budgetCapacity}，约 ${retryAfterSec} 秒后恢复）`;
  }
  return `账号并发繁忙，优先避让（${item.inflightCount}/${item.concurrencyBudget}，${resolveLeaseAvoidWindowSec(item.leaseUntil, nowMs)} 秒租约）`;
}

function buildAccountAvoidanceSummaryLabel(items: Array<{ rateLimitedUntil: string | null; budgetTokens?: number }>): string {
  return items.some((item) => item.rateLimitedUntil || (item.budgetTokens ?? 1) < 1)
    ? '账号预算避让'
    : '账号并发避让';
}

function reserveAccountSelectionLease(
  candidate: RouteChannelCandidate,
  nowMs = Date.now(),
  leaseMs = CHANNEL_SELECTION_LEASE_DEFAULT_MS,
): string {
  const budgetAttempt = tryConsumeAccountRateBudget(candidate, nowMs);
  if (!budgetAttempt.allowed) {
    return budgetAttempt.retryAtMs
      ? new Date(budgetAttempt.retryAtMs).toISOString()
      : new Date(nowMs).toISOString();
  }
  const normalizedLeaseMs = Math.min(
    CHANNEL_SELECTION_LEASE_MAX_MS,
    Math.max(CHANNEL_SELECTION_LEASE_MIN_MS, Math.trunc(leaseMs) || CHANNEL_SELECTION_LEASE_DEFAULT_MS),
  );
  const expiresAtMs = nowMs + normalizedLeaseMs;
  const leases = getAccountSelectionLeases(candidate.account.id, nowMs);
  accountSelectionLeases.set(candidate.account.id, [
    ...leases,
    { expiresAtMs },
  ]);
  scheduleAccountRuntimePersistence();
  return new Date(expiresAtMs).toISOString();
}

function releaseAccountSelectionLease(accountId: number, nowMs = Date.now()): void {
  const leases = getAccountSelectionLeases(accountId, nowMs);
  if (leases.length <= 1) {
    accountSelectionLeases.delete(accountId);
    scheduleAccountRuntimePersistence();
    return;
  }
  accountSelectionLeases.set(accountId, leases.slice(0, leases.length - 1));
  scheduleAccountRuntimePersistence();
}

function tryConsumeAccountRateBudget(candidate: RouteChannelCandidate, nowMs = Date.now()): {
  allowed: boolean;
  state: AccountRateBudgetState;
  retryAtMs: number | null;
} {
  const state = syncAccountRateBudgetConfig(candidate.account.id, nowMs);
  refillAccountRateBudget(state, nowMs);
  if (state.denyUntilMs != null && state.denyUntilMs > nowMs) {
    return {
      allowed: false,
      state,
      retryAtMs: state.denyUntilMs,
    };
  }
  if (state.tokens >= 1) {
    state.tokens = clampNumber(state.tokens - 1, 0, state.capacity);
    state.lastGrantedAtMs = nowMs;
    state.updatedAtMs = nowMs;
    scheduleAccountRuntimePersistence();
    return {
      allowed: true,
      state,
      retryAtMs: null,
    };
  }

  const retryAfterMs = Math.max(1, Math.ceil(((1 - state.tokens) / Math.max(state.refillPerSec, 0.01)) * 1000));
  state.denyUntilMs = nowMs + retryAfterMs;
  state.updatedAtMs = nowMs;
  scheduleAccountRuntimePersistence();
  return {
    allowed: false,
    state,
    retryAtMs: state.denyUntilMs,
  };
}

function partitionAccountSelectionLeases(
  candidates: RouteChannelCandidate[],
  nowMs = Date.now(),
): {
  preferred: RouteChannelCandidate[];
  avoided: Array<{
    candidate: RouteChannelCandidate;
    leaseUntil: string;
    inflightCount: number;
    concurrencyBudget: number;
    rateLimitedUntil: string | null;
    budgetTokens: number;
    budgetCapacity: number;
    budgetRefillPerSec: number;
  }>;
} {
  if (candidates.length <= 1) {
    const candidate = candidates[0];
    if (!candidate) {
      return {
        preferred: [],
        avoided: [],
      };
    }
    const state = accountRoutingStates.get(candidate.account.id) ?? null;
    const inflightCount = getAccountSelectionLeases(candidate.account.id, nowMs).length;
    const concurrencyBudget = getAccountConcurrencyBudget(candidate, state);
    const budgetState = syncAccountRateBudgetConfig(candidate.account.id, nowMs);
    const rateLimitedUntil = budgetState.denyUntilMs != null && budgetState.denyUntilMs > nowMs
      ? new Date(budgetState.denyUntilMs).toISOString()
      : null;
    const hasBudget = budgetState.tokens >= 1 && !rateLimitedUntil;
    if (inflightCount < concurrencyBudget && hasBudget) {
      return {
        preferred: candidates,
        avoided: [],
      };
    }
    return {
      preferred: hasBudget ? candidates : [],
      avoided: [{
        candidate,
        leaseUntil: getAccountSelectionLeaseUntil(candidate.account.id, nowMs) || new Date(nowMs).toISOString(),
        inflightCount,
        concurrencyBudget,
        rateLimitedUntil,
        budgetTokens: Number(budgetState.tokens.toFixed(3)),
        budgetCapacity: budgetState.capacity,
        budgetRefillPerSec: budgetState.refillPerSec,
      }],
    };
  }

  pruneAccountRoutingStates(nowMs);
  const preferred: RouteChannelCandidate[] = [];
  const busyFallback: RouteChannelCandidate[] = [];
  const uniqueAccountIds = new Set<number>();
  const avoided: Array<{
    candidate: RouteChannelCandidate;
    leaseUntil: string;
    inflightCount: number;
    concurrencyBudget: number;
    rateLimitedUntil: string | null;
    budgetTokens: number;
    budgetCapacity: number;
    budgetRefillPerSec: number;
  }> = [];

  for (const candidate of candidates) {
    uniqueAccountIds.add(candidate.account.id);
    const state = accountRoutingStates.get(candidate.account.id) ?? null;
    const inflightCount = getAccountSelectionLeases(candidate.account.id, nowMs).length;
    const concurrencyBudget = getAccountConcurrencyBudget(candidate, state);
    const budgetState = syncAccountRateBudgetConfig(candidate.account.id, nowMs);
    const rateLimitedUntil = budgetState.denyUntilMs != null && budgetState.denyUntilMs > nowMs
      ? new Date(budgetState.denyUntilMs).toISOString()
      : null;
    const hasBudget = budgetState.tokens >= 1 && !rateLimitedUntil;
    if (inflightCount < concurrencyBudget && hasBudget) {
      preferred.push(candidate);
      continue;
    }
    if (hasBudget) {
      busyFallback.push(candidate);
    }
    avoided.push({
      candidate,
      leaseUntil: getAccountSelectionLeaseUntil(candidate.account.id, nowMs) || new Date(nowMs).toISOString(),
      inflightCount,
      concurrencyBudget,
      rateLimitedUntil,
      budgetTokens: Number(budgetState.tokens.toFixed(3)),
      budgetCapacity: budgetState.capacity,
      budgetRefillPerSec: budgetState.refillPerSec,
    });
  }

  if (avoided.length > 0) {
    scheduleAccountRuntimePersistence();
  }

  return {
    preferred: preferred.length > 0
      ? preferred
      : (
        uniqueAccountIds.size <= 1
          ? candidates
          : (busyFallback.length > 0 ? busyFallback : [])
      ),
    avoided,
  };
}

function preferStickySessionCandidates(
  candidates: RouteChannelCandidate[],
  stickySessionKey: string | null | undefined,
  nowMs = Date.now(),
): {
  preferred: RouteChannelCandidate[];
  stickyBinding: StickySessionBinding | null;
  stickyReason: 'reused' | 'broken_by_failure' | 'broken_by_busy' | 'none';
} {
  if (candidates.length <= 1) {
    return {
      preferred: candidates,
      stickyBinding: getStickySessionBinding(stickySessionKey, nowMs),
      stickyReason: 'none',
    };
  }

  const stickyBinding = getStickySessionBinding(stickySessionKey, nowMs);
  if (!stickyBinding) {
    return {
      preferred: candidates,
      stickyBinding: null,
      stickyReason: 'none',
    };
  }

  const stickyCandidates = candidates.filter((candidate) => candidate.account.id === stickyBinding.accountId);
  if (stickyCandidates.length === 0) {
    stickySessionBindings.delete(hashStickySessionKey(String(stickySessionKey)));
    return {
      preferred: candidates,
      stickyBinding: null,
      stickyReason: 'none',
    };
  }

  const stickyState = accountRoutingStates.get(stickyBinding.accountId) ?? null;
  const stickyInflight = getAccountSelectionLeases(stickyBinding.accountId, nowMs).length;
  const stickyBudget = getAccountConcurrencyBudget(stickyCandidates[0], stickyState);
  const stickyBusy = stickyInflight >= stickyBudget && (stickyBinding.expiresAtMs - nowMs) > ACCOUNT_STICKY_BUSY_BREAK_MS;
  const stickyFailedRecently = stickyState?.lastFailureAtMs != null
    && (nowMs - stickyState.lastFailureAtMs) <= ACCOUNT_STICKY_FAILURE_BREAK_MS
    && (stickyState.lastSuccessAtMs ?? 0) < stickyState.lastFailureAtMs;

  if (stickyBusy) {
    return {
      preferred: candidates,
      stickyBinding,
      stickyReason: 'broken_by_busy',
    };
  }
  if (stickyFailedRecently) {
    return {
      preferred: candidates,
      stickyBinding,
      stickyReason: 'broken_by_failure',
    };
  }

  return {
    preferred: stickyCandidates,
    stickyBinding,
    stickyReason: 'reused',
  };
}

function bindStickySessionToCandidate(
  stickySessionKey: string | null | undefined,
  candidate: RouteChannelCandidate,
  nowMs = Date.now(),
  leaseMs = CHANNEL_SELECTION_LEASE_DEFAULT_MS,
): string | null {
  const normalizedKey = typeof stickySessionKey === 'string' ? stickySessionKey.trim() : '';
  if (!normalizedKey) return null;
  const stickyKeyHash = hashStickySessionKey(normalizedKey);

  const expiresAtMs = nowMs + Math.max(
    ACCOUNT_STICKY_BINDING_TTL_MS,
    Math.min(CHANNEL_SELECTION_LEASE_MAX_MS, Math.trunc(leaseMs) || CHANNEL_SELECTION_LEASE_DEFAULT_MS),
  );
  stickySessionBindings.set(stickyKeyHash, {
    accountId: candidate.account.id,
    expiresAtMs,
    lastUsedAtMs: nowMs,
  });
  stickySessionKeyByChannel.set(candidate.channel.id, stickyKeyHash);
  scheduleAccountRuntimePersistence();
  return new Date(expiresAtMs).toISOString();
}

function clearStickyBindingForChannel(channelId: number): void {
  const stickyKeyHash = stickySessionKeyByChannel.get(channelId);
  if (!stickyKeyHash) return;
  stickySessionKeyByChannel.delete(channelId);
  stickySessionBindings.delete(stickyKeyHash);
  scheduleAccountRuntimePersistence();
}

function getAccountLatencyMultiplier(latencyEmaMs: number | null): number {
  if (latencyEmaMs == null || !Number.isFinite(latencyEmaMs) || latencyEmaMs <= 0) return 1;
  const overflowRatio = Math.max(0, (latencyEmaMs - 2_500) / 7_500);
  return clampNumber(1 - (overflowRatio * 0.35), 0.65, 1);
}

function getAccountSuccessMultiplier(successEma: number): number {
  const normalized = clampNumber(successEma, 0.05, 0.99);
  const scaled = 0.55 + normalized * 0.65;
  return clampNumber(scaled, 0.55, 1.2);
}

function getAccountStickyMultiplier(
  candidate: RouteChannelCandidate,
  stickyBinding: StickySessionBinding | null,
  stickyReason: 'reused' | 'broken_by_failure' | 'broken_by_busy' | 'none',
): number {
  if (!stickyBinding) return 1;
  if (stickyBinding.accountId !== candidate.account.id) return 1;
  if (stickyReason === 'reused') return 1.35;
  if (stickyReason === 'broken_by_failure') return 0.85;
  if (stickyReason === 'broken_by_busy') return 0.92;
  return 1;
}

function getChannelSelectionLease(channelId: number, nowMs = Date.now()): ChannelSelectionLease | null {
  pruneChannelSelectionLeases(nowMs);
  return channelSelectionLeases.get(channelId) ?? null;
}

function getChannelSelectionLeaseUntil(channelId: number, nowMs = Date.now()): string | null {
  const lease = getChannelSelectionLease(channelId, nowMs);
  if (!lease) return null;
  return new Date(lease.expiresAtMs).toISOString();
}

function resolveChannelSelectionLeaseMs(candidate?: RouteChannelCandidate | null): number {
  const latencyMs = Number(candidate?.channel?.totalLatencyMs ?? 0);
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
    return CHANNEL_SELECTION_LEASE_DEFAULT_MS;
  }
  const scaledMs = Math.ceil(latencyMs * 3);
  return Math.min(
    CHANNEL_SELECTION_LEASE_MAX_MS,
    Math.max(CHANNEL_SELECTION_LEASE_MIN_MS, scaledMs),
  );
}

function reserveChannelSelectionLease(
  channelId: number,
  nowMs = Date.now(),
  leaseMs = CHANNEL_SELECTION_LEASE_DEFAULT_MS,
): string {
  const normalizedLeaseMs = Math.min(
    CHANNEL_SELECTION_LEASE_MAX_MS,
    Math.max(CHANNEL_SELECTION_LEASE_MIN_MS, Math.trunc(leaseMs) || CHANNEL_SELECTION_LEASE_DEFAULT_MS),
  );
  const expiresAtMs = nowMs + normalizedLeaseMs;
  channelSelectionLeases.set(channelId, { expiresAtMs });
  return new Date(expiresAtMs).toISOString();
}

function releaseChannelSelectionLease(channelId: number): void {
  channelSelectionLeases.delete(channelId);
}

function partitionChannelSelectionLeases<T extends { channel: { id: number } }>(
  candidates: T[],
  nowMs = Date.now(),
): {
  preferred: T[];
  avoided: Array<{ candidate: T; leaseUntil: string }>;
} {
  if (candidates.length <= 1) {
    return {
      preferred: candidates,
      avoided: [],
    };
  }

  const preferred: T[] = [];
  const avoided: Array<{ candidate: T; leaseUntil: string }> = [];
  for (const candidate of candidates) {
    const leaseUntil = getChannelSelectionLeaseUntil(candidate.channel.id, nowMs);
    if (!leaseUntil) {
      preferred.push(candidate);
      continue;
    }
    avoided.push({ candidate, leaseUntil });
  }

  return {
    preferred,
    avoided,
  };
}

function resolveLeaseAvoidWindowSec(leaseUntil: string, nowMs = Date.now()): number {
  const expiresAtMs = Date.parse(leaseUntil);
  if (Number.isNaN(expiresAtMs)) return 1;
  return Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000));
}

function resolveTokenRouterCacheTtlMs(): number {
  const raw = Math.trunc(config.tokenRouterCacheTtlMs || 0);
  return Math.max(100, raw);
}

function isCacheFresh(loadedAt: number, nowMs: number): boolean {
  return nowMs - loadedAt < resolveTokenRouterCacheTtlMs();
}

async function loadEnabledRoutes(nowMs = Date.now()): Promise<RouteRow[]> {
  if (isCacheFresh(routeCacheSnapshot.loadedAt, nowMs)) {
    return routeCacheSnapshot.routes;
  }

  const rawRoutes = await db.select().from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.enabled, true))
    .all();
  const explicitGroupRouteIds = rawRoutes
    .filter((route: typeof schema.tokenRoutes.$inferSelect) => normalizeRouteMode(route.routeMode) === 'explicit_group')
    .map((route: typeof schema.tokenRoutes.$inferSelect) => route.id);
  const sourceRows = explicitGroupRouteIds.length > 0
    ? await db.select().from(schema.routeGroupSources)
      .where(inArray(schema.routeGroupSources.groupRouteId, explicitGroupRouteIds))
      .all()
    : [];
  const sourceIdsByRouteId = new Map<number, number[]>();
  for (const row of sourceRows) {
    if (!sourceIdsByRouteId.has(row.groupRouteId)) {
      sourceIdsByRouteId.set(row.groupRouteId, []);
    }
    sourceIdsByRouteId.get(row.groupRouteId)!.push(row.sourceRouteId);
  }
  const routes = rawRoutes.map((route: typeof schema.tokenRoutes.$inferSelect) => ({
    ...route,
    routeMode: normalizeRouteMode(route.routeMode),
    sourceRouteIds: Array.from(new Set(sourceIdsByRouteId.get(route.id) ?? [])),
  }));
  routeCacheSnapshot = {
    loadedAt: nowMs,
    routes,
  };
  return routes;
}

async function loadRouteMatch(route: RouteRow, nowMs = Date.now()): Promise<RouteMatch> {
  const cached = routeMatchCache.get(route.id);
  if (cached && isCacheFresh(cached.loadedAt, nowMs)) {
    return cached.match;
  }

  const enabledRoutes = await loadEnabledRoutes(nowMs);
  const routeIds = (() => {
    if (!isExplicitGroupRoute(route)) {
      return [route.id];
    }
    const sourceRouteIds = Array.from(new Set(route.sourceRouteIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0)));
    return sourceRouteIds.length > 0 ? sourceRouteIds : [route.id];
  })();
  const enabledSourceRoutes = isExplicitGroupRoute(route)
    ? enabledRoutes.filter((item) => (
      routeIds.includes(item.id)
      && (
        item.id === route.id
        || (!isExplicitGroupRoute(item) && isExactRouteModelPattern(item.modelPattern))
      )
    ))
    : enabledRoutes.filter((item) => routeIds.includes(item.id));
  const enabledSourceRouteIds = enabledSourceRoutes.map((item) => item.id);
  const fallbackSourceModelByRouteId = new Map<number, string>(
    enabledSourceRoutes
      .filter((item) => isExactRouteModelPattern(item.modelPattern))
      .map((item) => [item.id, (item.modelPattern || '').trim()]),
  );
  const channels = enabledSourceRouteIds.length > 0
    ? await db
      .select()
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
      .where(inArray(schema.routeChannels.routeId, enabledSourceRouteIds))
      .all()
    : [];

  const mapped = channels.map((row: {
    route_channels: typeof schema.routeChannels.$inferSelect;
    accounts: typeof schema.accounts.$inferSelect;
    sites: typeof schema.sites.$inferSelect;
    account_tokens: typeof schema.accountTokens.$inferSelect | null;
  }) => {
    const persistedSourceModel = normalizeChannelSourceModel(row.route_channels.sourceModel);
    const fallbackSourceModel = fallbackSourceModelByRouteId.get(row.route_channels.routeId) || null;
    return {
      channel: {
        ...row.route_channels,
        sourceModel: persistedSourceModel || fallbackSourceModel,
        sourceModelDerived: !persistedSourceModel && !!fallbackSourceModel,
      },
      account: row.accounts,
      site: row.sites,
      token: row.account_tokens,
    };
  });

  const match = { route, channels: mapped };
  routeMatchCache.set(route.id, {
    loadedAt: nowMs,
    match,
  });
  return match;
}

function patchCachedChannel(channelId: number, apply: (channel: ChannelRow) => void): void {
  for (const entry of routeMatchCache.values()) {
    const target = entry.match.channels.find((item) => item.channel.id === channelId);
    if (!target) continue;
    apply(target.channel);
  }
}

export function invalidateTokenRouterCache(): void {
  routeCacheSnapshot = {
    loadedAt: 0,
    routes: [],
  };
  routeMatchCache.clear();
  channelSelectionLeases.clear();
  accountSelectionLeases.clear();
  stickySessionKeyByChannel.clear();
}

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

export function isChannelRecentlyFailed(
  channel: FailureAwareChannel,
  nowMs = Date.now(),
  avoidSec = resolveRecentFailureAvoidWindowSec(channel),
): boolean {
  if (avoidSec <= 0) return false;
  if ((channel.failCount ?? 0) <= 0) return false;
  if (!channel.lastFailAt) return false;

  const failTs = Date.parse(channel.lastFailAt);
  if (Number.isNaN(failTs)) return false;

  return nowMs - failTs < avoidSec * 1000;
}

function resolveRecentFailureAvoidWindowSec(channel: FailureAwareChannel): number {
  return Math.max(
    60,
    Math.trunc(resolveWeightedFailureCooldownMs(
      Math.max(1, Math.trunc((channel.consecutiveFailCount ?? channel.failCount ?? 0) || 1)),
      'server',
    ) / 1000),
  );
}

export function filterRecentlyFailedCandidates<T extends { channel: FailureAwareChannel }>(
  candidates: T[],
  nowMs = Date.now(),
  avoidSec?: number,
): T[] {
  if (candidates.length <= 1) return candidates;
  if (avoidSec == null || avoidSec <= 0) return candidates;

  const healthy = candidates.filter((candidate) => !isChannelRecentlyFailed(candidate.channel, nowMs, avoidSec));
  // If all channels failed recently, keep them all and let weight/random decide.
  return healthy.length > 0 ? healthy : candidates;
}

function partitionRecentlyFailedCandidates<T extends { channel: FailureAwareChannel }>(
  candidates: T[],
  nowMs = Date.now(),
  avoidSec?: number,
): {
  preferred: T[];
  avoided: T[];
} {
  if (candidates.length === 0) {
    return { preferred: [], avoided: [] };
  }
  const effectiveAvoidSec = avoidSec ?? Math.max(
    ...candidates.map((candidate) => resolveRecentFailureAvoidWindowSec(candidate.channel)),
    60,
  );
  if (effectiveAvoidSec <= 0) {
    return { preferred: candidates, avoided: [] };
  }
  const preferred = candidates.filter((candidate) => !isChannelRecentlyFailed(candidate.channel, nowMs, effectiveAvoidSec));
  const avoided = candidates.filter((candidate) => isChannelRecentlyFailed(candidate.channel, nowMs, effectiveAvoidSec));
  return { preferred, avoided };
}

function buildExcludedSiteIdsFromMatch(
  _match: RouteMatch,
  _excludeChannelIds: number[],
  seed: ReadonlySet<number> = new Set<number>(),
): Set<number> {
  // Channel-level failover must not automatically escalate into site-level blocking.
  // Some failures are account/token/model specific, so request-level site avoidance
  // is only applied when the caller explicitly marks the site as temporarily bad.
  return new Set<number>(seed);
}

function getChannelPersistedSuccessAtMs(
  channel: Pick<ChannelRow, 'lastUsedAt' | 'successCount'>,
): number | null {
  if (Math.max(0, channel.successCount ?? 0) <= 0) return null;
  return parseIsoTimeMs(channel.lastUsedAt);
}

function partitionMostRecentSuccessfulSiteCandidates<
  T extends {
    site: { id: number };
    channel: Pick<ChannelRow, 'lastUsedAt' | 'successCount' | 'lastFailAt'>;
  },
>(
  candidates: T[],
): {
  preferred: T[];
  avoided: T[];
  preferredSiteIds: Set<number>;
} {
  if (candidates.length <= 1) {
    return {
      preferred: candidates,
      avoided: [],
      preferredSiteIds: new Set(candidates.map((candidate) => candidate.site.id)),
    };
  }

  const siteSuccessAtMs = new Map<number, number>();
  for (const candidate of candidates) {
    const successAtMs = getChannelPersistedSuccessAtMs(candidate.channel);
    const failureAtMs = parseIsoTimeMs(candidate.channel.lastFailAt);
    if (successAtMs == null || successAtMs <= (failureAtMs ?? 0)) continue;
    siteSuccessAtMs.set(
      candidate.site.id,
      Math.max(siteSuccessAtMs.get(candidate.site.id) ?? 0, successAtMs),
    );
  }

  let latestSuccessAtMs: number | null = null;
  const preferredSiteIds = new Set<number>();
  for (const [siteId, successAtMs] of siteSuccessAtMs.entries()) {
    if (latestSuccessAtMs == null || successAtMs > latestSuccessAtMs) {
      latestSuccessAtMs = successAtMs;
      preferredSiteIds.clear();
      preferredSiteIds.add(siteId);
      continue;
    }
    if (successAtMs === latestSuccessAtMs) {
      preferredSiteIds.add(siteId);
    }
  }

  if (preferredSiteIds.size === 0) {
    return {
      preferred: candidates,
      avoided: [],
      preferredSiteIds,
    };
  }

  return {
    preferred: candidates.filter((candidate) => preferredSiteIds.has(candidate.site.id)),
    avoided: candidates.filter((candidate) => !preferredSiteIds.has(candidate.site.id)),
    preferredSiteIds,
  };
}

function subtractCandidatesByChannelId<
  T extends {
    channel: { id: number };
  },
>(
  source: T[],
  excluded: T[],
): T[] {
  if (source.length === 0 || excluded.length === 0) return source;
  const excludedIds = new Set(excluded.map((candidate) => candidate.channel.id));
  return source.filter((candidate) => !excludedIds.has(candidate.channel.id));
}

function partitionPreferredSuccessfulAccountCandidates<
  T extends {
    account: { id: number };
  },
>(
  candidates: T[],
  nowMs = Date.now(),
): {
  anchor: T[];
  preferred: T[];
  avoided: T[];
  anchorAccountIds: Set<number>;
  preferredAccountIds: Set<number>;
  source: 'none' | 'account_runtime_success';
} {
  if (candidates.length <= 1) {
    return {
      anchor: candidates,
      preferred: candidates,
      avoided: [],
      anchorAccountIds: new Set(candidates.map((candidate) => candidate.account.id)),
      preferredAccountIds: new Set(candidates.map((candidate) => candidate.account.id)),
      source: 'none',
    };
  }

  let latestSuccessAtMs: number | null = null;
  const anchorAccountIds = new Set<number>();
  const preferredAccountIds = new Set<number>();

  for (const candidate of candidates) {
    const state = accountRoutingStates.get(candidate.account.id);
    const successAtMs = state?.lastSuccessAtMs ?? null;
    const failureAtMs = state?.lastFailureAtMs ?? null;
    if (successAtMs == null || successAtMs <= (failureAtMs ?? 0)) continue;
    preferredAccountIds.add(candidate.account.id);
    if (latestSuccessAtMs == null || successAtMs > latestSuccessAtMs) {
      latestSuccessAtMs = successAtMs;
      anchorAccountIds.clear();
      anchorAccountIds.add(candidate.account.id);
      continue;
    }
    if (successAtMs === latestSuccessAtMs) {
      anchorAccountIds.add(candidate.account.id);
    }
  }

  if (preferredAccountIds.size === 0) {
    return {
      anchor: [],
      preferred: [],
      avoided: candidates,
      anchorAccountIds,
      preferredAccountIds,
      source: 'none',
    };
  }

  return {
    anchor: candidates.filter((candidate) => anchorAccountIds.has(candidate.account.id)),
    preferred: candidates.filter((candidate) => preferredAccountIds.has(candidate.account.id)),
    avoided: candidates.filter((candidate) => !preferredAccountIds.has(candidate.account.id)),
    anchorAccountIds,
    preferredAccountIds,
    source: 'account_runtime_success',
  };
}

function partitionPreferredSuccessfulChannelCandidates<
  T extends {
    channel: Pick<ChannelRow, 'id' | 'lastUsedAt' | 'successCount' | 'lastFailAt'>;
  },
>(
  candidates: T[],
): {
  anchor: T[];
  preferred: T[];
  avoided: T[];
  anchorChannelIds: Set<number>;
  preferredChannelIds: Set<number>;
  source: 'none' | 'channel_persisted_success';
} {
  if (candidates.length <= 1) {
    return {
      anchor: candidates,
      preferred: candidates,
      avoided: [],
      anchorChannelIds: new Set(candidates.map((candidate) => candidate.channel.id)),
      preferredChannelIds: new Set(candidates.map((candidate) => candidate.channel.id)),
      source: 'none',
    };
  }

  let latestSuccessAtMs: number | null = null;
  const anchorChannelIds = new Set<number>();
  const preferredChannelIds = new Set<number>();

  for (const candidate of candidates) {
    const successAtMs = getChannelPersistedSuccessAtMs(candidate.channel);
    const failureAtMs = parseIsoTimeMs(candidate.channel.lastFailAt);
    if (successAtMs == null || successAtMs <= (failureAtMs ?? 0)) continue;
    preferredChannelIds.add(candidate.channel.id);
    if (latestSuccessAtMs == null || successAtMs > latestSuccessAtMs) {
      latestSuccessAtMs = successAtMs;
      anchorChannelIds.clear();
      anchorChannelIds.add(candidate.channel.id);
      continue;
    }
    if (successAtMs === latestSuccessAtMs) {
      anchorChannelIds.add(candidate.channel.id);
    }
  }

  if (preferredChannelIds.size === 0) {
    return {
      anchor: [],
      preferred: [],
      avoided: candidates,
      anchorChannelIds,
      preferredChannelIds,
      source: 'none',
    };
  }

  return {
    anchor: candidates.filter((candidate) => anchorChannelIds.has(candidate.channel.id)),
    preferred: candidates.filter((candidate) => preferredChannelIds.has(candidate.channel.id)),
    avoided: candidates.filter((candidate) => !preferredChannelIds.has(candidate.channel.id)),
    anchorChannelIds,
    preferredChannelIds,
    source: 'channel_persisted_success',
  };
}

function partitionPreferredSuccessfulSiteCandidates<
  T extends {
    site: { id: number };
    channel: Pick<ChannelRow, 'id' | 'lastUsedAt' | 'successCount' | 'lastFailAt'>;
  },
>(
  candidates: T[],
  modelName: string,
  nowMs = Date.now(),
): {
  anchor: T[];
  preferred: T[];
  avoided: T[];
  anchorSiteIds: Set<number>;
  preferredSiteIds: Set<number>;
  source: 'none' | 'site_success_pool';
} {
  if (candidates.length <= 1) {
    return {
      anchor: candidates,
      preferred: candidates,
      avoided: [],
      anchorSiteIds: new Set(candidates.map((candidate) => candidate.site.id)),
      preferredSiteIds: new Set(candidates.map((candidate) => candidate.site.id)),
      source: 'none',
    };
  }

  const normalizedModel = normalizeModelAlias(modelName || '');
  const preferCodexClaudePool = isCodexOrClaudePreferenceModel(normalizedModel);
  const siteSuccessAtMs = new Map<number, number>();

  for (const candidate of candidates) {
    const siteId = candidate.site.id;
    const persistedSuccessAtMs = getChannelPersistedSuccessAtMs(candidate.channel);
    const persistedFailureAtMs = parseIsoTimeMs(candidate.channel.lastFailAt);
    if (
      persistedSuccessAtMs != null
      && persistedSuccessAtMs > (persistedFailureAtMs ?? 0)
      && (!preferCodexClaudePool || (nowMs - persistedSuccessAtMs) <= CODEX_CLAUDE_SUCCESS_POOL_RECENT_MS)
    ) {
      siteSuccessAtMs.set(siteId, Math.max(siteSuccessAtMs.get(siteId) ?? 0, persistedSuccessAtMs));
    }

    if (!normalizedModel) continue;
    const state = getSiteModelRuntimeHealthState(siteId, normalizedModel);
    const runtimeSuccessAtMs = state?.lastSuccessAtMs ?? null;
    const runtimeFailureAtMs = state?.lastFailureAtMs ?? null;
    if (runtimeSuccessAtMs == null || runtimeSuccessAtMs <= (runtimeFailureAtMs ?? 0)) continue;
    if (preferCodexClaudePool && (nowMs - runtimeSuccessAtMs) > CODEX_CLAUDE_SUCCESS_POOL_RECENT_MS) continue;
    if (isRuntimeHealthBreakerOpen(state, nowMs)) continue;
    siteSuccessAtMs.set(siteId, Math.max(siteSuccessAtMs.get(siteId) ?? 0, runtimeSuccessAtMs));
  }

  if (preferCodexClaudePool && siteSuccessAtMs.size > CODEX_CLAUDE_SUCCESS_POOL_SIZE) {
    const limitedRecentSites = Array.from(siteSuccessAtMs.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, CODEX_CLAUDE_SUCCESS_POOL_SIZE);
    siteSuccessAtMs.clear();
    for (const [siteId, successAtMs] of limitedRecentSites) {
      siteSuccessAtMs.set(siteId, successAtMs);
    }
  }

  if (siteSuccessAtMs.size === 0) {
    return {
      anchor: [],
      preferred: [],
      avoided: candidates,
      anchorSiteIds: new Set<number>(),
      preferredSiteIds: new Set<number>(),
      source: 'none',
    };
  }

  let latestSuccessAtMs: number | null = null;
  const anchorSiteIds = new Set<number>();
  const preferredSiteIds = new Set<number>(siteSuccessAtMs.keys());
  for (const [siteId, successAtMs] of siteSuccessAtMs.entries()) {
    if (latestSuccessAtMs == null || successAtMs > latestSuccessAtMs) {
      latestSuccessAtMs = successAtMs;
      anchorSiteIds.clear();
      anchorSiteIds.add(siteId);
      continue;
    }
    if (successAtMs === latestSuccessAtMs) {
      anchorSiteIds.add(siteId);
    }
  }

  return {
    anchor: candidates.filter((candidate) => anchorSiteIds.has(candidate.site.id)),
    preferred: candidates.filter((candidate) => preferredSiteIds.has(candidate.site.id)),
    avoided: candidates.filter((candidate) => !preferredSiteIds.has(candidate.site.id)),
    anchorSiteIds,
    preferredSiteIds,
    source: 'site_success_pool',
  };
}

type CandidateSelectionPool = {
  candidates: RouteChannelCandidate[];
  scope:
    | 'anchor_site_recent_channel'
    | 'anchor_site_success_channel'
    | 'anchor_site_success_account'
    | 'anchor_site_other'
    | 'fallback_site_recent_channel'
    | 'fallback_site_success_channel'
    | 'fallback_site_success_account'
    | 'fallback_site_other'
    | 'other_site_recent_channel'
    | 'other_site_success_channel'
    | 'other_site_success_account'
    | 'other_site_other';
};

function describeCandidatePoolScope(scope: CandidateSelectionPool['scope']): {
  avoidedReason: string;
  summaryLabel: string;
} {
  switch (scope) {
    case 'anchor_site_recent_channel':
      return {
        avoidedReason: '当前优先复用最近成功的站点与账号通道；仅当该通道不可用时才会切同站其他账号或其他站点',
        summaryLabel: '最近成功通道复用',
      };
    case 'anchor_site_success_channel':
      return {
        avoidedReason: '当前优先复用最近成功站点内已验证成功的其他通道；仅当这些通道都不可用时才会切同站其他账号或其他站点',
        summaryLabel: '成功通道池复用',
      };
    case 'anchor_site_success_account':
      return {
        avoidedReason: '当前优先复用最近成功站点内已验证成功且可用的账号；仅当这些账号都不可用时才会切同站其他账号或其他站点',
        summaryLabel: '成功账号复用',
      };
    case 'anchor_site_other':
      return {
        avoidedReason: '当前优先留在最近成功站点内继续尝试其他可用账号/通道；仅当该站点全部不可用时才会切到其他站点',
        summaryLabel: '同站账号兜底',
      };
    case 'fallback_site_recent_channel':
      return {
        avoidedReason: '当前优先复用其他已验证成功站点中的最近成功通道；仅当这些站点都不可用时才会扩散到未验证站点',
        summaryLabel: '其他成功站点最近通道复用',
      };
    case 'fallback_site_success_channel':
      return {
        avoidedReason: '当前优先复用其他已验证成功站点中的成功通道池；仅当这些站点都不可用时才会扩散到未验证站点',
        summaryLabel: '其他成功站点通道池复用',
      };
    case 'fallback_site_success_account':
      return {
        avoidedReason: '当前优先复用其他已验证成功站点中的成功账号；仅当这些站点都不可用时才会扩散到未验证站点',
        summaryLabel: '其他成功站点账号复用',
      };
    case 'fallback_site_other':
      return {
        avoidedReason: '当前优先继续尝试其他已验证成功站点；仅当成功站点全部不可用时才会扩散到未验证站点',
        summaryLabel: '其他成功站点兜底',
      };
    case 'other_site_recent_channel':
      return {
        avoidedReason: '当前优先先用已验证成功站点；仅当它们都不可用时才会尝试其他站点的最近成功通道',
        summaryLabel: '其他站点最近通道',
      };
    case 'other_site_success_channel':
      return {
        avoidedReason: '当前优先先用已验证成功站点；仅当它们都不可用时才会尝试其他站点的成功通道池',
        summaryLabel: '其他站点成功通道池',
      };
    case 'other_site_success_account':
      return {
        avoidedReason: '当前优先先用已验证成功站点；仅当它们都不可用时才会尝试其他站点的成功账号',
        summaryLabel: '其他站点成功账号',
      };
    case 'other_site_other':
      return {
        avoidedReason: '当前候选属于未验证站点，仅在已验证成功站点全部不可用后才会尝试',
        summaryLabel: '未验证站点探测',
      };
  }
}

function buildCandidateSelectionPools(
  candidates: RouteChannelCandidate[],
  modelName: string,
  nowMs = Date.now(),
): {
  pools: CandidateSelectionPool[];
  sitePartition: ReturnType<typeof partitionPreferredSuccessfulSiteCandidates<RouteChannelCandidate>>;
} {
  const pools: CandidateSelectionPool[] = [];
  const sitePartition = partitionPreferredSuccessfulSiteCandidates(candidates, modelName, nowMs);

  const pushPool = (scope: CandidateSelectionPool['scope'], rows: RouteChannelCandidate[]) => {
    if (rows.length === 0) return;
    pools.push({ scope, candidates: rows });
  };

  const pushScopedPools = (
    scopePrefix: 'anchor_site' | 'fallback_site' | 'other_site',
    scopedCandidates: RouteChannelCandidate[],
  ) => {
    if (scopedCandidates.length === 0) return;

    const channelPartition = partitionPreferredSuccessfulChannelCandidates(scopedCandidates);
    pushPool(`${scopePrefix}_recent_channel`, channelPartition.anchor);
    const otherSuccessfulChannels = subtractCandidatesByChannelId(channelPartition.preferred, channelPartition.anchor);
    pushPool(`${scopePrefix}_success_channel`, otherSuccessfulChannels);

    const remainingAfterChannelSuccess = subtractCandidatesByChannelId(scopedCandidates, channelPartition.preferred);
    const accountPartition = partitionPreferredSuccessfulAccountCandidates(remainingAfterChannelSuccess, nowMs);
    pushPool(`${scopePrefix}_success_account`, accountPartition.preferred);

    const remaining = subtractCandidatesByChannelId(remainingAfterChannelSuccess, accountPartition.preferred);
    pushPool(`${scopePrefix}_other`, remaining);
  };

  if (sitePartition.preferred.length > 0) {
    pushScopedPools('anchor_site', sitePartition.anchor);
    pushScopedPools('fallback_site', subtractCandidatesByChannelId(sitePartition.preferred, sitePartition.anchor));
  }
  pushScopedPools('other_site', sitePartition.avoided);

  return {
    pools,
    sitePartition,
  };
}

function partitionModelPreferredSiteCandidates<
  T extends {
    site: { id: number };
  },
>(
  candidates: T[],
  modelName: string,
  nowMs = Date.now(),
): {
  preferred: T[];
  avoided: T[];
  preferredSiteIds: Set<number>;
  source: 'none' | 'model_runtime_success';
} {
  if (candidates.length <= 1) {
    return {
      preferred: candidates,
      avoided: [],
      preferredSiteIds: new Set(candidates.map((candidate) => candidate.site.id)),
      source: 'none',
    };
  }

  const normalizedModel = normalizeModelAlias(modelName || '');
  if (!normalizedModel) {
    return {
      preferred: candidates,
      avoided: [],
      preferredSiteIds: new Set(candidates.map((candidate) => candidate.site.id)),
      source: 'none',
    };
  }

  let latestSuccessAtMs: number | null = null;
  const preferredSiteIds = new Set<number>();

  for (const candidate of candidates) {
    const state = getSiteModelRuntimeHealthState(candidate.site.id, normalizedModel);
    const successAtMs = state?.lastSuccessAtMs ?? null;
    const failureAtMs = state?.lastFailureAtMs ?? null;
    if (successAtMs == null || successAtMs <= (failureAtMs ?? 0)) continue;
    if (latestSuccessAtMs == null || successAtMs > latestSuccessAtMs) {
      latestSuccessAtMs = successAtMs;
      preferredSiteIds.clear();
      preferredSiteIds.add(candidate.site.id);
      continue;
    }
    if (successAtMs === latestSuccessAtMs) {
      preferredSiteIds.add(candidate.site.id);
    }
  }

  if (preferredSiteIds.size === 0) {
    return {
      preferred: candidates,
      avoided: [],
      preferredSiteIds: new Set(candidates.map((candidate) => candidate.site.id)),
      source: 'none',
    };
  }

  const currentlyHealthyPreferredSiteIds = new Set<number>();
  for (const siteId of preferredSiteIds) {
    const state = getSiteModelRuntimeHealthState(siteId, normalizedModel);
    if (state?.lastFailureAtMs != null && (state.lastFailureAtMs ?? 0) >= (state.lastSuccessAtMs ?? 0)) {
      continue;
    }
    if (isRuntimeHealthBreakerOpen(state, nowMs)) continue;
    currentlyHealthyPreferredSiteIds.add(siteId);
  }

  const effectivePreferredSiteIds = currentlyHealthyPreferredSiteIds.size > 0
    ? currentlyHealthyPreferredSiteIds
    : preferredSiteIds;

  return {
    preferred: candidates.filter((candidate) => effectivePreferredSiteIds.has(candidate.site.id)),
    avoided: candidates.filter((candidate) => !effectivePreferredSiteIds.has(candidate.site.id)),
    preferredSiteIds: effectivePreferredSiteIds,
    source: 'model_runtime_success',
  };
}

function sortCandidatesForRecoveryPreference<T extends { channel: FailureAwareChannel }>(candidates: T[]): T[] {
  return [...candidates].sort((left, right) => {
    const cooldownCompare = compareNullableTimeAsc(left.channel.cooldownUntil, right.channel.cooldownUntil);
    if (cooldownCompare !== 0) return cooldownCompare;
    const failCompare = compareNullableTimeAsc(left.channel.lastFailAt, right.channel.lastFailAt);
    if (failCompare !== 0) return failCompare;
    return Math.max(0, left.channel.failCount ?? 0) - Math.max(0, right.channel.failCount ?? 0);
  });
}

async function markPersistedModelUnavailableForChannel(
  channel: Pick<ChannelRow, 'tokenId'>,
  accountId: number,
  modelName?: string | null,
): Promise<void> {
  const normalizedModelName = (modelName || '').trim();
  if (!normalizedModelName) return;
  const checkedAt = new Date().toISOString();

  if (typeof channel.tokenId === 'number' && Number.isFinite(channel.tokenId)) {
    if (runtimeDbDialect === 'mysql') {
      const existing = await db.select({ id: schema.tokenModelAvailability.id })
        .from(schema.tokenModelAvailability)
        .where(
          and(
            eq(schema.tokenModelAvailability.tokenId, channel.tokenId),
            eq(schema.tokenModelAvailability.modelName, normalizedModelName),
          ),
        )
        .get();
      if (existing) {
        await db.update(schema.tokenModelAvailability).set({
          available: false,
          checkedAt,
        }).where(eq(schema.tokenModelAvailability.id, existing.id)).run();
      } else {
        await db.insert(schema.tokenModelAvailability).values({
          tokenId: channel.tokenId,
          modelName: normalizedModelName,
          available: false,
          checkedAt,
        }).run();
      }
    } else {
      await (db.insert(schema.tokenModelAvailability).values({
        tokenId: channel.tokenId,
        modelName: normalizedModelName,
        available: false,
        checkedAt,
      }) as any)
        .onConflictDoUpdate({
          target: [schema.tokenModelAvailability.tokenId, schema.tokenModelAvailability.modelName],
          set: {
            available: false,
            checkedAt,
          },
        })
        .run();
    }
    return;
  }

  if (runtimeDbDialect === 'mysql') {
    const existing = await db.select({ id: schema.modelAvailability.id })
      .from(schema.modelAvailability)
      .where(
        and(
          eq(schema.modelAvailability.accountId, accountId),
          eq(schema.modelAvailability.modelName, normalizedModelName),
        ),
      )
      .get();
    if (existing) {
      await db.update(schema.modelAvailability).set({
        available: false,
        checkedAt,
      }).where(eq(schema.modelAvailability.id, existing.id)).run();
    } else {
      await db.insert(schema.modelAvailability).values({
        accountId,
        modelName: normalizedModelName,
        available: false,
        checkedAt,
      }).run();
    }
    return;
  }

  await (db.insert(schema.modelAvailability).values({
    accountId,
    modelName: normalizedModelName,
    available: false,
    checkedAt,
  }) as any)
    .onConflictDoUpdate({
      target: [schema.modelAvailability.accountId, schema.modelAvailability.modelName],
      set: {
        available: false,
        checkedAt,
      },
    })
    .run();
}

async function restorePersistedModelAvailabilityForChannel(
  channel: Pick<ChannelRow, 'tokenId'>,
  accountId: number,
  modelName?: string | null,
): Promise<void> {
  const normalizedModelName = (modelName || '').trim();
  if (!normalizedModelName) return;
  const checkedAt = new Date().toISOString();

  if (typeof channel.tokenId === 'number' && Number.isFinite(channel.tokenId)) {
    if (runtimeDbDialect === 'mysql') {
      const existing = await db.select({ id: schema.tokenModelAvailability.id })
        .from(schema.tokenModelAvailability)
        .where(
          and(
            eq(schema.tokenModelAvailability.tokenId, channel.tokenId),
            eq(schema.tokenModelAvailability.modelName, normalizedModelName),
          ),
        )
        .get();
      if (!existing) return;
      await db.update(schema.tokenModelAvailability).set({
        available: true,
        checkedAt,
      }).where(eq(schema.tokenModelAvailability.id, existing.id)).run();
      return;
    }

    await (db.insert(schema.tokenModelAvailability).values({
      tokenId: channel.tokenId,
      modelName: normalizedModelName,
      available: true,
      checkedAt,
    }) as any)
      .onConflictDoUpdate({
        target: [schema.tokenModelAvailability.tokenId, schema.tokenModelAvailability.modelName],
        set: {
          available: true,
          checkedAt,
        },
      })
      .run();
    return;
  }

  if (runtimeDbDialect === 'mysql') {
    const existing = await db.select({ id: schema.modelAvailability.id })
      .from(schema.modelAvailability)
      .where(
        and(
          eq(schema.modelAvailability.accountId, accountId),
          eq(schema.modelAvailability.modelName, normalizedModelName),
        ),
      )
      .get();
    if (!existing) return;
    await db.update(schema.modelAvailability).set({
      available: true,
      checkedAt,
    }).where(eq(schema.modelAvailability.id, existing.id)).run();
    return;
  }

  await (db.insert(schema.modelAvailability).values({
    accountId,
    modelName: normalizedModelName,
    available: true,
    checkedAt,
  }) as any)
    .onConflictDoUpdate({
      target: [schema.modelAvailability.accountId, schema.modelAvailability.modelName],
      set: {
        available: true,
        checkedAt,
      },
    })
    .run();
}

async function disableDefinitivelyBrokenTokenForChannel(
  channel: Pick<ChannelRow, 'id' | 'tokenId'>,
): Promise<void> {
  const tokenId = typeof channel.tokenId === 'number' && channel.tokenId > 0
    ? channel.tokenId
    : null;
  if (tokenId == null) return;

  const nowIso = new Date().toISOString();
  await db.update(schema.accountTokens).set({
    enabled: false,
    isDefault: false,
    updatedAt: nowIso,
  }).where(eq(schema.accountTokens.id, tokenId)).run();

  for (const entry of routeMatchCache.values()) {
    for (const candidate of entry.match.channels) {
      if (candidate.channel.tokenId !== tokenId) continue;
      if (candidate.token) {
        candidate.token.enabled = false;
        candidate.token.isDefault = false;
        candidate.token.updatedAt = nowIso;
      }
    }
  }
}

export interface RouteDecisionCandidate {
  channelId: number;
  accountId: number;
  username: string;
  siteName: string;
  tokenName: string;
  priority: number;
  weight: number;
  eligible: boolean;
  failureCategory?: string | null;
  governanceAction?: string | null;
  governanceSubjectType?: string | null;
  governanceSubjectId?: number | null;
  governanceSuppressUntil?: string | null;
  governanceLastProbeStatus?: string | null;
  sourceModelDerived?: boolean;
  modelCapabilityVerified?: boolean;
  recentlyFailed: boolean;
  avoidedByRecentFailure: boolean;
  avoidedByAttemptedSite?: boolean;
  avoidedByInflightLease?: boolean;
  avoidedByAccountLease?: boolean;
  cooldownUntil?: string | null;
  lastFailAt?: string | null;
  leasedUntil?: string | null;
  accountLeaseUntil?: string | null;
  consecutiveFailCount?: number;
  cooldownLevel?: number;
  probability: number;
  reason: string;
  circuitStatus?: {
    state: 'closed' | 'open';
    isOpen: boolean;
    reason: string;
  };
  modelCircuitStatus?: {
    state: 'closed' | 'open' | 'half_open';
    isOpen: boolean;
    isHalfOpen: boolean;
    reason: string;
    effectiveMultiplier: number;
  };
  siteRuntimeState?: {
    globalMultiplier: number;
    modelMultiplier: number;
    combinedMultiplier: number;
    globalBreakerOpen: boolean;
    modelBreakerOpen: boolean;
  };
  accountRuntimeState?: {
    successEma: number;
    latencyEmaMs: number | null;
    inflightCount: number;
    concurrencyBudget: number;
    rateLimitCapacity: number;
    rateLimitTokens: number;
    rateLimitRefillPerSec: number;
    rateLimitedUntil: string | null;
    rateLimited: boolean;
    stickyPreferred: boolean;
    stickyActive: boolean;
    stickyBoundAccountId: number | null;
    stickyUntil: string | null;
    consecutiveFailures: number;
  };
}

export interface RouteDecisionExplanation {
  requestedModel: string;
  actualModel: string;
  matched: boolean;
  routeId?: number;
  modelPattern?: string;
  selectedChannelId?: number;
  selectedAccountId?: number;
  selectedLabel?: string;
  summary: string[];
  candidates: RouteDecisionCandidate[];
}

const DEFAULT_DOWNSTREAM_POLICY: DownstreamRoutingPolicy = EMPTY_DOWNSTREAM_ROUTING_POLICY;

type ExplainSelectionOptions = {
  excludeChannelIds?: number[];
  excludeSiteIds?: ReadonlySet<number>;
  bypassSourceModelCheck?: boolean;
  useChannelSourceModelForCost?: boolean;
  downstreamPolicy?: DownstreamRoutingPolicy;
};

type PricingReferenceRefreshOptions = {
  useChannelSourceModelForCost?: boolean;
  downstreamPolicy?: DownstreamRoutingPolicy;
  refreshedKeys?: Set<string>;
};

type CandidateEligibilityOptions = {
  requestedModel: string;
  bypassSourceModelCheck?: boolean;
  excludeChannelIds?: number[];
  excludeSiteIds?: ReadonlySet<number>;
  nowIso?: string;
  nowMs?: number;
  runtimeModelName?: string | null;
  persistedUnavailableModels?: PersistedUnavailableModelSnapshot;
  governanceSnapshot?: GovernanceSnapshot;
  governanceBlock?: CandidateGovernanceBlock | null;
};

type CostSignal = {
  unitCost: number;
  source: 'observed' | 'configured' | 'catalog' | 'fallback';
};

export function isRegexModelPattern(pattern: string): boolean {
  return pattern.trim().toLowerCase().startsWith('re:');
}

function readRegexQuantifierLength(pattern: string, startIndex: number): number {
  const ch = pattern[startIndex];
  if (ch === '*' || ch === '+' || ch === '?') return 1;
  if (ch !== '{') return 0;

  let index = startIndex + 1;
  let sawDigit = false;
  while (index < pattern.length && /\d/.test(pattern[index])) {
    sawDigit = true;
    index += 1;
  }
  if (!sawDigit) return 0;

  if (pattern[index] === ',') {
    index += 1;
    while (index < pattern.length && /\d/.test(pattern[index])) {
      index += 1;
    }
  }

  if (pattern[index] !== '}') return 0;
  return index - startIndex + 1;
}

function isSafeRegexPatternBody(body: string): boolean {
  if (!body || body.length > MAX_ROUTE_REGEX_BODY_LENGTH) return false;
  if (!/^[a-z0-9\s.^$|()[\]{}+*?\\:_/-]+$/i.test(body)) return false;
  if (body.includes('(?=') || body.includes('(?!') || body.includes('(?<=') || body.includes('(?<!') || body.includes('(?<')) {
    return false;
  }
  if (/(^|[^\\])\\[1-9]/.test(body)) {
    return false;
  }

  const groupStack: Array<{ hasInnerQuantifier: boolean; hasAlternation: boolean }> = [];
  let escaped = false;
  let inCharClass = false;

  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      continue;
    }

    if (ch === '[') {
      inCharClass = true;
      continue;
    }

    if (ch === '(') {
      if (body[index + 1] === '?') {
        if (body[index + 2] !== ':') {
          return false;
        }
        groupStack.push({ hasInnerQuantifier: false, hasAlternation: false });
        index += 2;
        continue;
      }

      groupStack.push({ hasInnerQuantifier: false, hasAlternation: false });
      continue;
    }

    if (ch === '|') {
      if (groupStack.length > 0) {
        groupStack[groupStack.length - 1].hasAlternation = true;
      }
      continue;
    }

    if (ch === ')') {
      const group = groupStack.pop();
      if (!group) return false;

      const quantifierLength = readRegexQuantifierLength(body, index + 1);
      if (quantifierLength > 0 && (group.hasInnerQuantifier || group.hasAlternation)) {
        return false;
      }

      const parent = groupStack[groupStack.length - 1];
      if (parent && (group.hasInnerQuantifier || quantifierLength > 0)) {
        parent.hasInnerQuantifier = true;
      }
      continue;
    }

    const quantifierLength = readRegexQuantifierLength(body, index);
    if (quantifierLength > 0) {
      if (groupStack.length > 0) {
        groupStack[groupStack.length - 1].hasInnerQuantifier = true;
      }
      index += quantifierLength - 1;
    }
  }

  return !escaped && !inCharClass && groupStack.length === 0;
}

export function parseRegexModelPattern(pattern: string): RegExp | null {
  if (!isRegexModelPattern(pattern)) return null;
  const body = pattern.trim().slice(3).trim();
  if (!body) return null;
  if (!isSafeRegexPatternBody(body)) return null;
  try {
    return new RegExp(body);
  } catch {
    return null;
  }
}

export function matchesModelPattern(model: string, pattern: string): boolean {
  const normalizedPattern = (pattern || '').trim();
  if (!normalizedPattern) return false;

  if (normalizedPattern === model) return true;

  if (isRegexModelPattern(normalizedPattern)) {
    const re = parseRegexModelPattern(normalizedPattern);
    return !!re && re.test(model);
  }

  return minimatch(model, normalizedPattern);
}

function isExactRouteModelPattern(pattern: string): boolean {
  const normalizedPattern = (pattern || '').trim();
  if (!normalizedPattern) return false;
  if (isRegexModelPattern(normalizedPattern)) return false;
  return !/[\*\?\[]/.test(normalizedPattern);
}

function normalizeRouteMode(routeMode: string | null | undefined): RouteMode {
  return routeMode === 'explicit_group' ? 'explicit_group' : 'pattern';
}

function isExplicitGroupRoute(route: Pick<RouteRow, 'routeMode'> | Pick<typeof schema.tokenRoutes.$inferSelect, 'routeMode'>): boolean {
  return normalizeRouteMode(route.routeMode) === 'explicit_group';
}

function normalizeRouteDisplayName(displayName: string | null | undefined): string {
  return (displayName || '').trim();
}

function isRouteDisplayNameMatch(model: string, displayName: string | null | undefined): boolean {
  const alias = normalizeRouteDisplayName(displayName);
  return !!alias && alias === model;
}

function matchesRouteRequestModel(model: string, route: RouteRow): boolean {
  if (isExplicitGroupRoute(route)) {
    return isRouteDisplayNameMatch(model, route.displayName);
  }
  return matchesModelPattern(model, route.modelPattern) || isRouteDisplayNameMatch(model, route.displayName);
}

function findPreferredRouteForModel(routes: RouteRow[], model: string): RouteRow | undefined {
  // explicit_group 按显示名命中时优先（e9628ae：覆盖/重定向旧的精确路由）
  return routes.find((route) => isExplicitGroupRoute(route) && isRouteDisplayNameMatch(model, route.displayName))
    || routes.find((route) => (
      !isExplicitGroupRoute(route)
      && isExactRouteModelPattern(route.modelPattern)
      && (route.modelPattern || '').trim() === model
    ))
    || routes.find((route) => !isExplicitGroupRoute(route) && isRouteDisplayNameMatch(model, route.displayName))
    || routes.find((route) => !isExplicitGroupRoute(route) && matchesModelPattern(model, route.modelPattern));
}

function getExposedModelNameForRoute(route: RouteRow): string {
  return normalizeRouteDisplayName(route.displayName) || route.modelPattern;
}

function hasCustomDisplayName(route: Pick<RouteRow, 'modelPattern' | 'displayName'>): boolean {
  const displayName = normalizeRouteDisplayName(route.displayName);
  const modelPattern = (route.modelPattern || '').trim();
  return !!displayName && displayName !== modelPattern;
}

function buildVisibleEnabledRoutes(routes: RouteRow[]): RouteRow[] {
  return routes.filter((route: RouteRow) => {
    if (!route.enabled) return false;
    if (isExplicitGroupRoute(route)) {
      return normalizeRouteDisplayName(route.displayName).length > 0;
    }
    return hasCustomDisplayName(route);
  });
}

function buildVisibleEnabledRoutesForPolicy(
  routes: RouteRow[],
  downstreamPolicy: DownstreamRoutingPolicy,
): RouteRow[] {
  const visibleRoutes = buildVisibleEnabledRoutes(routes);
  const globalAllowedPatterns = Array.isArray(downstreamPolicy.globalAllowedModels)
    ? downstreamPolicy.globalAllowedModels
    : [];
  const supportedPatterns = Array.isArray(downstreamPolicy.supportedModels)
    ? downstreamPolicy.supportedModels
    : [];
  const allowedRouteIdSet = new Set(
    Array.isArray(downstreamPolicy.allowedRouteIds)
      ? downstreamPolicy.allowedRouteIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0)
      : [],
  );

  if (globalAllowedPatterns.length === 0 && supportedPatterns.length === 0 && allowedRouteIdSet.size === 0) {
    return visibleRoutes;
  }

  const globallyFilteredRoutes = globalAllowedPatterns.length > 0
    ? visibleRoutes.filter((route) => {
      const exposedName = getExposedModelNameForRoute(route).trim();
      return !!exposedName && globalAllowedPatterns.some((pattern) => matchesModelPattern(exposedName, pattern));
    })
    : visibleRoutes;

  if (supportedPatterns.length === 0 && allowedRouteIdSet.size === 0) {
    return globallyFilteredRoutes;
  }

  return globallyFilteredRoutes.filter((route) => {
    const exposedName = getExposedModelNameForRoute(route).trim();
    if (!exposedName) return false;
    if (supportedPatterns.some((pattern) => matchesModelPattern(exposedName, pattern))) {
      return true;
    }
    return allowedRouteIdSet.has(route.id) && isExplicitGroupRoute(route);
  });
}

function normalizeModelAlias(modelName: string): string {
  const normalized = (modelName || '').trim().toLowerCase();
  if (!normalized) return '';
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1);
  }
  return normalized;
}

function isModelAliasEquivalent(left: string, right: string): boolean {
  const a = normalizeModelAlias(left);
  const b = normalizeModelAlias(right);
  return !!a && !!b && a === b;
}

function getCandidateModelCircuitStatus(
  channelId: number,
  modelName?: string | null,
  nowMs = Date.now(),
): ModelCircuitStatusView | null {
  const normalizedModelName = normalizeModelAlias(modelName || '');
  if (!normalizedModelName) return null;
  return getModelCircuitStatus(channelId, normalizedModelName, nowMs);
}

function describeModelCircuitStatus(status?: ModelCircuitStatusView | null): string {
  if (!status) return '关闭';
  if (status.state === 'open') {
    return `打开（${status.reason}，倍率=${status.effectiveMultiplier.toFixed(2)}）`;
  }
  if (status.state === 'half_open') {
    return `半开（${status.reason}，倍率=${status.effectiveMultiplier.toFixed(2)}）`;
  }
  return `关闭（倍率=${status.effectiveMultiplier.toFixed(2)}）`;
}

function shouldOpenSiteLevelModelCircuit(reasonParts: string[]): boolean {
  return reasonParts.some((reason) => reason.startsWith('站点状态='))
    || reasonParts.includes('冷却中')
    || reasonParts.includes('令牌不可用')
    || reasonParts.includes('当前请求已尝试')
    || reasonParts.includes('模型熔断中');
}

function channelSupportsRequestedModel(channelSourceModel: string | null | undefined, requestedModel: string): boolean {
  const source = (channelSourceModel || '').trim();
  if (!source) return true;
  if (source === requestedModel) return true;
  if (isModelAliasEquivalent(source, requestedModel)) return true;
  if (matchesModelPattern(requestedModel, source)) return true;
  return false;
}

function isModelAllowedByDownstreamPolicy(requestedModel: string, policy: DownstreamRoutingPolicy): boolean {
  const globalAllowedPatterns = Array.isArray(policy.globalAllowedModels)
    ? policy.globalAllowedModels
    : [];
  if (globalAllowedPatterns.length > 0 && !globalAllowedPatterns.some((pattern) => matchesModelPattern(requestedModel, pattern))) {
    return false;
  }

  const supportedPatterns = Array.isArray(policy.supportedModels)
    ? policy.supportedModels
    : [];
  const hasSupportedPatterns = supportedPatterns.length > 0;
  const hasAllowedRoutes = policy.allowedRouteIds.length > 0;
  if (!hasSupportedPatterns && !hasAllowedRoutes) return policy.denyAllWhenEmpty === true ? false : true;
  const matchedSupportedPattern = supportedPatterns.some((pattern) => matchesModelPattern(requestedModel, pattern));
  if (matchedSupportedPattern) return true;
  if (hasAllowedRoutes) return true;
  return false;
}

function resolveMappedModel(requestedModel: string, modelMapping?: string | null): string {
  if (!modelMapping) return requestedModel;

  let parsed: unknown;
  try {
    parsed = JSON.parse(modelMapping);
  } catch {
    return requestedModel;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return requestedModel;
  }

  const entries = Object.entries(parsed as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0) as Array<[string, string]>;

  const exact = entries.find(([pattern]) => pattern === requestedModel);
  if (exact) return exact[1].trim();

  for (const [pattern, target] of entries) {
    if (matchesModelPattern(requestedModel, pattern)) {
      return target.trim();
    }
  }

  return requestedModel;
}

function normalizeChannelSourceModel(channelSourceModel: string | null | undefined): string {
  return (channelSourceModel || '').trim();
}

function resolveActualModelForSelectedChannel(
  requestedModel: string,
  route: RouteRow,
  mappedModel: string,
  channelSourceModel: string | null | undefined,
): string {
  const sourceModel = normalizeChannelSourceModel(channelSourceModel);
  if (isRouteDisplayNameMatch(requestedModel, route.displayName) && sourceModel) {
    return sourceModel;
  }
  return mappedModel;
}

function resolveRouteStrategy(route: RouteRow): RouteRoutingStrategy {
  return normalizeRouteRoutingStrategy(route.routingStrategy);
}

function parseIsoTimeMs(value?: string | null): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareNullableTimeAsc(left?: string | null, right?: string | null): number {
  const leftMs = parseIsoTimeMs(left);
  const rightMs = parseIsoTimeMs(right);
  if (leftMs == null && rightMs == null) return 0;
  if (leftMs == null) return -1;
  if (rightMs == null) return 1;
  return leftMs - rightMs;
}

function resolveEffectiveUnitCost(candidate: RouteChannelCandidate, modelName: string): CostSignal {
  const successCount = Math.max(0, candidate.channel.successCount ?? 0);
  const totalCost = Math.max(0, candidate.channel.totalCost ?? 0);
  const configured = candidate.account.unitCost ?? null;

  if (successCount > 0 && totalCost > 0) {
    return {
      unitCost: Math.max(totalCost / successCount, MIN_EFFECTIVE_UNIT_COST),
      source: 'observed',
    };
  }

  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return {
      unitCost: Math.max(configured, MIN_EFFECTIVE_UNIT_COST),
      source: 'configured',
    };
  }

  const catalogCost = getCachedModelRoutingReferenceCost({
    siteId: candidate.site.id,
    accountId: candidate.account.id,
    modelName,
  });
  if (typeof catalogCost === 'number' && Number.isFinite(catalogCost) && catalogCost > 0) {
    return {
      unitCost: Math.max(catalogCost, MIN_EFFECTIVE_UNIT_COST),
      source: 'catalog',
    };
  }

  return {
    unitCost: Math.max(config.routingFallbackUnitCost || 1, MIN_EFFECTIVE_UNIT_COST),
    source: 'fallback',
  };
}

type SiteHistoricalHealthMetrics = {
  multiplier: number;
  totalCalls: number;
  successRate: number | null;
  avgLatencyMs: number | null;
};

function buildSiteHistoricalHealthMetrics(candidates: RouteChannelCandidate[]): Map<number, SiteHistoricalHealthMetrics> {
  const totals = new Map<number, {
    totalCalls: number;
    successCount: number;
    failCount: number;
    totalLatencyMs: number;
    latencySamples: number;
  }>();

  for (const candidate of candidates) {
    const siteId = candidate.site.id;
    if (!totals.has(siteId)) {
      totals.set(siteId, {
        totalCalls: 0,
        successCount: 0,
        failCount: 0,
        totalLatencyMs: 0,
        latencySamples: 0,
      });
    }
    const target = totals.get(siteId)!;
    const successCount = Math.max(0, candidate.channel.successCount ?? 0);
    const failCount = Math.max(0, candidate.channel.failCount ?? 0);
    target.successCount += successCount;
    target.failCount += failCount;
    target.totalCalls += successCount + failCount;
    if (successCount > 0) {
      target.totalLatencyMs += Math.max(0, candidate.channel.totalLatencyMs ?? 0);
      target.latencySamples += successCount;
    }
  }

  const metrics = new Map<number, SiteHistoricalHealthMetrics>();
  for (const [siteId, total] of totals.entries()) {
    if (total.totalCalls <= 0) {
      metrics.set(siteId, {
        multiplier: 1,
        totalCalls: 0,
        successRate: null,
        avgLatencyMs: null,
      });
      continue;
    }

    const sampleFactor = clampNumber(total.totalCalls / SITE_HISTORICAL_HEALTH_MAX_SAMPLE, 0, 1);
    const successRate = total.successCount / total.totalCalls;
    const successPenaltyFactor = 1 - ((1 - successRate) * 0.55 * sampleFactor);
    const avgLatencyMs = total.latencySamples > 0
      ? Math.round(total.totalLatencyMs / total.latencySamples)
      : null;
    const latencyPenaltyRatio = avgLatencyMs == null
      ? 0
      : clampNumber(
        (avgLatencyMs - SITE_HISTORICAL_LATENCY_BASELINE_MS) / SITE_HISTORICAL_LATENCY_WINDOW_MS,
        0,
        1,
      ) * sampleFactor;
    const latencyFactor = 1 - (latencyPenaltyRatio * SITE_HISTORICAL_MAX_LATENCY_PENALTY);
    metrics.set(siteId, {
      multiplier: clampNumber(
        successPenaltyFactor * latencyFactor,
        SITE_HISTORICAL_HEALTH_MIN_MULTIPLIER,
        1,
      ),
      totalCalls: total.totalCalls,
      successRate,
      avgLatencyMs,
    });
  }

  return metrics;
}

function isExplicitTokenChannel(candidate: RouteChannelCandidate): boolean {
  return typeof candidate.channel.tokenId === 'number' && candidate.channel.tokenId > 0;
}

function hasVerifiedModelCapability(candidate: RouteChannelCandidate, requestedModel: string, nowMs = Date.now()): boolean {
  const normalizedRequestedModel = normalizeModelAlias(requestedModel || '');
  if (!normalizedRequestedModel) return false;
  if (!candidate.channel.sourceModelDerived) return true;
  if ((candidate.channel.successCount ?? 0) <= 0) return false;
  const lastSuccessAtMs = getChannelPersistedSuccessAtMs(candidate.channel);
  const lastFailureAtMs = parseIsoTimeMs(candidate.channel.lastFailAt);
  if (lastSuccessAtMs != null && lastSuccessAtMs > (lastFailureAtMs ?? 0)) return true;
  const siteModelState = getSiteModelRuntimeHealthState(candidate.site.id, normalizedRequestedModel);
  return !!siteModelState && (siteModelState.lastSuccessAtMs ?? 0) > (siteModelState.lastFailureAtMs ?? 0) && !isRuntimeHealthBreakerOpen(siteModelState, nowMs);
}

function shouldSoftParkUnknownCapabilityCandidate(
  candidate: RouteChannelCandidate,
  requestedModel: string,
  governanceBlock?: CandidateGovernanceBlock | null,
  nowMs = Date.now(),
): boolean {
  if (!candidate.channel.sourceModelDerived) return false;
  if (governanceBlock?.reasonCode !== 'invalid_channel') return false;
  if (hasVerifiedModelCapability(candidate, requestedModel, nowMs)) return false;
  const failCount = Math.max(0, candidate.channel.failCount ?? 0);
  const consecutiveFailCount = Math.max(0, candidate.channel.consecutiveFailCount ?? 0);
  return failCount >= 2 || consecutiveFailCount >= 2;
}

export class TokenRouter {
  async getVisiblePublicModels(): Promise<string[]> {
    const routes = await loadEnabledRoutes();
    return Array.from(new Set(
      buildVisibleEnabledRoutes(routes)
        .map((route) => getExposedModelNameForRoute(route).trim())
        .filter((name) => name.length > 0),
    ));
  }

  /**
   * Find matching route and select a channel for the given model.
   * Returns null if no route/channel available.
   */
  async selectChannel(requestedModel: string, downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    await ensureRoutingRuntimeStateLoaded();

    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, requestedModel, downstreamPolicy);
  }

  async previewSelectedChannel(
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    await ensureRoutingRuntimeStateLoaded();

    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, requestedModel, downstreamPolicy, [], false);
  }

  /**
   * Select next channel for failover (exclude already-tried channels).
   */
  async selectNextChannel(
    requestedModel: string,
    excludeChannelIds: number[],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
    excludeSiteIds: ReadonlySet<number> = new Set<number>(),
  ): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    await ensureRoutingRuntimeStateLoaded();

    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, requestedModel, downstreamPolicy, excludeChannelIds, true, excludeSiteIds);
  }

  async explainSelection(
    requestedModel: string,
    excludeChannelIds: number[] = [],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
    excludeSiteIds: ReadonlySet<number> = new Set<number>(),
  ): Promise<RouteDecisionExplanation> {
    await ensureRoutingRuntimeStateLoaded();
    const match = await this.findRoute(requestedModel, downstreamPolicy);
    return await this.explainSelectionFromMatch(match, requestedModel, { excludeChannelIds, excludeSiteIds, downstreamPolicy });
  }

  async explainSelectionForRoute(
    routeId: number,
    requestedModel: string,
    excludeChannelIds: number[] = [],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
    excludeSiteIds: ReadonlySet<number> = new Set<number>(),
  ): Promise<RouteDecisionExplanation> {
    await ensureRoutingRuntimeStateLoaded();
    const match = await this.findRouteById(routeId, downstreamPolicy);
    return await this.explainSelectionFromMatch(match, requestedModel, { excludeChannelIds, excludeSiteIds, downstreamPolicy });
  }

  async explainSelectionRouteWide(routeId: number, downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY): Promise<RouteDecisionExplanation> {
    await ensureRoutingRuntimeStateLoaded();
    const match = await this.findRouteById(routeId, downstreamPolicy);
    const fallbackRequestedModel = match?.route.modelPattern || `route:${routeId}`;
    return await this.explainSelectionFromMatch(match, fallbackRequestedModel, {
      bypassSourceModelCheck: true,
      useChannelSourceModelForCost: true,
      downstreamPolicy,
    });
  }

  async refreshPricingReferenceCosts(
    requestedModel: string,
    options: PricingReferenceRefreshOptions = {},
  ): Promise<void> {
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;
    const match = await this.findRoute(requestedModel, downstreamPolicy);
    await this.refreshPricingReferenceCostsForMatch(match, requestedModel, options);
  }

  async refreshPricingReferenceCostsForRoute(
    routeId: number,
    requestedModel: string,
    options: PricingReferenceRefreshOptions = {},
  ): Promise<void> {
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;
    const match = await this.findRouteById(routeId, downstreamPolicy);
    await this.refreshPricingReferenceCostsForMatch(match, requestedModel, options);
  }

  async refreshRouteWidePricingReferenceCosts(
    routeId: number,
    options: Omit<PricingReferenceRefreshOptions, 'useChannelSourceModelForCost'> = {},
  ): Promise<void> {
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;
    const match = await this.findRouteById(routeId, downstreamPolicy);
    const requestedModel = match?.route.modelPattern || `route:${routeId}`;
    await this.refreshPricingReferenceCostsForMatch(match, requestedModel, {
      ...options,
      useChannelSourceModelForCost: true,
    });
  }

  private async explainSelectionFromMatch(
    match: RouteMatch | null,
    requestedModel: string,
    options: ExplainSelectionOptions = {},
  ): Promise<RouteDecisionExplanation> {
    const excludeChannelIds = options.excludeChannelIds ?? [];
    const excludeSiteIds = options.excludeSiteIds ?? new Set<number>();
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;

    if (!match) {
      return {
        requestedModel,
        actualModel: requestedModel,
        matched: false,
        summary: ['未匹配到启用的路由'],
        candidates: [],
      };
    }

    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const bypassSourceModelCheck = (options.bypassSourceModelCheck ?? false) || requestedByDisplayName;
    const useChannelSourceModelForCost = (options.useChannelSourceModelForCost ?? false) || requestedByDisplayName;
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const routeStrategy = resolveRouteStrategy(match.route);
    const runtimeModelResolver = requestedByDisplayName
      ? ((candidate: RouteChannelCandidate) => normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
      : mappedModel;
    const persistedUnavailableModels = await loadPersistedUnavailableModelsForCandidates(match.channels);
    const governanceSnapshot = await loadGovernanceSnapshotForCandidates(match.channels);

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const effectiveExcludeSiteIds = buildExcludedSiteIdsFromMatch(match, excludeChannelIds, excludeSiteIds);
    const stickyPreference = preferStickySessionCandidates(
      match.channels,
      downstreamPolicy.stickySessionKey,
      nowMs,
    );
    const accountBudgetById = new Map<number, AccountRateBudgetState>();
    for (const row of match.channels) {
      accountBudgetById.set(row.account.id, syncAccountRateBudgetConfig(row.account.id, nowMs));
    }
    const stickyAccountId = stickyPreference.stickyBinding?.accountId ?? null;
    const stickyUntil = stickyPreference.stickyBinding
      ? new Date(stickyPreference.stickyBinding.expiresAtMs).toISOString()
      : null;
    const summary: string[] = [
      `命中路由：${match.route.modelPattern}`,
      routeStrategy === 'round_robin'
        ? '路由策略：轮询'
        : (routeStrategy === 'stable_first' ? '路由策略：稳定优先' : '路由策略：按权重随机'),
    ];
    if (requestedByDisplayName) {
      summary.push(`按显示名命中：${normalizeRouteDisplayName(match.route.displayName)}`);
      summary.push('显示名仅用于聚合展示，实际转发模型按选中通道来源模型决定');
    }
    const availableByPriority = new Map<number, RouteChannelCandidate[]>();
    const candidates: RouteDecisionCandidate[] = [];
    const candidateMap = new Map<number, RouteDecisionCandidate>();

    for (const row of match.channels) {
      const runtimeModelName = typeof runtimeModelResolver === 'function'
        ? runtimeModelResolver(row)
        : runtimeModelResolver;
      const governanceBlock = findGovernanceBlockFromSnapshot(
        governanceSnapshot,
        row,
        runtimeModelName,
      );
      const reasonParts = this.getCandidateEligibilityReasons(row, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        excludeSiteIds: effectiveExcludeSiteIds,
        nowIso,
        nowMs,
        runtimeModelName,
        persistedUnavailableModels,
        governanceSnapshot,
        governanceBlock,
      });
      const modelCircuitStatus = getCandidateModelCircuitStatus(row.channel.id, runtimeModelName, nowMs);
      const runtimeHealthDetails = getSiteRuntimeHealthDetails(row.site.id, runtimeModelName, nowMs);
      const runtimeCircuit = buildRuntimeCircuitStatus(runtimeHealthDetails);

      const recentlyFailed = routeStrategy !== 'round_robin'
        ? isChannelRecentlyFailed(row.channel, nowMs)
        : false;
      const modelCapabilityVerified = hasVerifiedModelCapability(row, requestedModel, nowMs);
      const eligible = reasonParts.length === 0;
      let reason = eligible ? '可用' : reasonParts.join('、');
      if (eligible && governanceBlock?.state === 'probing') {
        reason = formatGovernanceReason(governanceBlock);
      }
      if (eligible && row.channel.sourceModelDerived && !modelCapabilityVerified) {
        reason = `${reason}（模型能力未验证，当前按低权重试探）`;
      }
      if (
        !eligible
        && runtimeCircuit.isOpen
        && !reason.includes('模型熔断')
        && !reason.includes('站点熔断')
        && shouldOpenSiteLevelModelCircuit(reasonParts)
      ) {
        reason = `${reason}、${runtimeCircuit.reason}`;
      }
      const candidate: RouteDecisionCandidate = {
        channelId: row.channel.id,
        accountId: row.account.id,
        username: row.account.username || `account-${row.account.id}`,
        siteName: row.site.name || 'unknown',
        tokenName: row.token?.name || 'default',
        priority: row.channel.priority ?? 0,
        weight: row.channel.weight ?? 10,
        eligible,
        failureCategory: governanceBlock?.reasonCode ?? null,
        governanceAction: governanceBlock?.state ?? null,
        governanceSubjectType: governanceBlock?.subjectType ?? null,
        governanceSubjectId: governanceBlock?.subjectId ?? null,
        governanceSuppressUntil: governanceBlock?.suppressUntil ?? null,
        governanceLastProbeStatus: governanceBlock?.state === 'probing' ? 'probing' : null,
        sourceModelDerived: !!row.channel.sourceModelDerived,
        modelCapabilityVerified,
        recentlyFailed,
        avoidedByRecentFailure: false,
        avoidedByAttemptedSite: effectiveExcludeSiteIds.has(row.site.id),
        avoidedByInflightLease: false,
        avoidedByAccountLease: false,
        cooldownUntil: row.channel.cooldownUntil ?? null,
        lastFailAt: row.channel.lastFailAt ?? null,
        leasedUntil: getChannelSelectionLeaseUntil(row.channel.id, nowMs),
        accountLeaseUntil: getAccountSelectionLeaseUntil(row.account.id, nowMs),
        consecutiveFailCount: Math.max(0, row.channel.consecutiveFailCount ?? 0),
        cooldownLevel: Math.max(0, row.channel.cooldownLevel ?? 0),
        probability: 0,
        reason,
        circuitStatus: runtimeCircuit,
        modelCircuitStatus: modelCircuitStatus ?? undefined,
        siteRuntimeState: {
          globalMultiplier: runtimeHealthDetails.globalMultiplier,
          modelMultiplier: runtimeHealthDetails.modelMultiplier,
          combinedMultiplier: runtimeHealthDetails.combinedMultiplier,
          globalBreakerOpen: runtimeHealthDetails.globalBreakerOpen,
          modelBreakerOpen: runtimeHealthDetails.modelBreakerOpen,
        },
        accountRuntimeState: {
          successEma: (accountRoutingStates.get(row.account.id)?.successEma ?? 0.5),
          latencyEmaMs: accountRoutingStates.get(row.account.id)?.latencyEmaMs ?? null,
          inflightCount: getAccountSelectionLeases(row.account.id, nowMs).length,
          concurrencyBudget: getAccountConcurrencyBudget(row, accountRoutingStates.get(row.account.id) ?? null),
          rateLimitCapacity: accountBudgetById.get(row.account.id)?.capacity ?? ACCOUNT_RATE_LIMIT_BURST_MIN,
          rateLimitTokens: Number((accountBudgetById.get(row.account.id)?.tokens ?? ACCOUNT_RATE_LIMIT_BURST_MIN).toFixed(3)),
          rateLimitRefillPerSec: accountBudgetById.get(row.account.id)?.refillPerSec ?? ACCOUNT_RATE_LIMIT_REFILL_MIN_PER_SEC,
          rateLimitedUntil: accountBudgetById.get(row.account.id)?.denyUntilMs
            ? new Date(accountBudgetById.get(row.account.id)!.denyUntilMs!).toISOString()
            : null,
          rateLimited: !!(accountBudgetById.get(row.account.id)?.denyUntilMs && accountBudgetById.get(row.account.id)!.denyUntilMs! > nowMs),
          stickyPreferred: stickyAccountId === row.account.id && stickyPreference.stickyReason === 'reused',
          stickyActive: stickyAccountId === row.account.id,
          stickyBoundAccountId: stickyAccountId,
          stickyUntil,
          consecutiveFailures: accountRoutingStates.get(row.account.id)?.consecutiveFailures ?? 0,
        },
      };
      candidates.push(candidate);
      candidateMap.set(candidate.channelId, candidate);

      if (eligible) {
        const priority = row.channel.priority ?? 0;
        if (!availableByPriority.has(priority)) availableByPriority.set(priority, []);
        availableByPriority.get(priority)!.push(row);
      }
    }

    if (availableByPriority.size === 0) {
      summary.push('没有可用通道（全部被禁用、站点不可用、冷却或令牌不可用）');
      return {
        requestedModel,
        actualModel: mappedModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        summary,
        candidates,
      };
    }

    const modelCircuitOpenCount = candidates.filter((candidate) => candidate.modelCircuitStatus?.isOpen).length;
    if (modelCircuitOpenCount > 0) {
      summary.push(`模型熔断避让 ${modelCircuitOpenCount}`);
    }
    if (stickyPreference.stickyReason === 'reused' && stickyAccountId != null) {
      summary.push(`账号粘性复用 account=${stickyAccountId}`);
    } else if (stickyPreference.stickyReason === 'broken_by_failure' && stickyAccountId != null) {
      summary.push(`账号粘性已打破：最近失败 account=${stickyAccountId}`);
    } else if (stickyPreference.stickyReason === 'broken_by_busy' && stickyAccountId != null) {
      summary.push(`账号粘性已打破：账号繁忙 account=${stickyAccountId}`);
    }
    if (routeStrategy === 'round_robin') {
      const rawOrdered = this.getRoundRobinCandidates(match.channels.filter((row) => {
        const target = candidateMap.get(row.channel.id);
        return !!target?.eligible;
      }));
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawOrdered, runtimeModelResolver, nowMs);
      const fullyBlockedByRuntimeBreaker =
        breakerFiltered.avoided.length > 0 && breakerFiltered.candidates.length === rawOrdered.length;
      if (breakerFiltered.avoided.length > 0) {
        for (const item of breakerFiltered.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.eligible = false;
          target.reason = item.reason;
          target.circuitStatus = {
            state: 'open',
            isOpen: true,
            reason: item.reason,
          };
        }
        const breakerSummaryLabel = breakerFiltered.avoided.some((item) => item.reason.includes('模型熔断'))
          ? '运行时熔断避让'
          : '站点熔断避让';
        summary.push(`${breakerSummaryLabel} ${breakerFiltered.avoided.length}`);
      }
      if (fullyBlockedByRuntimeBreaker) {
        summary.push('本次未选出通道');
        return {
          requestedModel,
          actualModel: mappedModel,
          matched: true,
          routeId: match.route.id,
          modelPattern: match.route.modelPattern,
          summary,
          candidates,
        };
      }

      const recentFailurePartition = partitionRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      if (recentFailurePartition.avoided.length > 0) {
        for (const row of recentFailurePartition.avoided) {
          const target = candidateMap.get(row.channel.id);
          if (!target) continue;
          target.avoidedByRecentFailure = true;
          target.reason = `最近失败，轮询优先避让（${resolveRecentFailureAvoidWindowSec(row.channel)} 秒窗口）`;
        }
        summary.push(`轮询最近失败避让 ${recentFailurePartition.avoided.length}`);
      }
      if (recentFailurePartition.preferred.length === 0 && recentFailurePartition.avoided.length > 0) {
        summary.push('全部候选近期失败，当前避让中');
        summary.push('本次未选出通道');
        return {
          requestedModel,
          actualModel: mappedModel,
          matched: true,
          routeId: match.route.id,
          modelPattern: match.route.modelPattern,
          summary,
          candidates,
        };
      }
      const recoveryCandidates = recentFailurePartition.preferred;

      const accountLeasePartition = partitionAccountSelectionLeases(recoveryCandidates, nowMs);
      if (accountLeasePartition.avoided.length > 0) {
        for (const item of accountLeasePartition.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.avoidedByAccountLease = true;
          target.reason = buildAccountRateLimitReason(item, nowMs);
        }
        summary.push(`${buildAccountAvoidanceSummaryLabel(accountLeasePartition.avoided)} ${accountLeasePartition.avoided.length}`);
      }
      const accountLeaseCandidates = accountLeasePartition.preferred;
      const leasePartition = partitionChannelSelectionLeases(
        accountLeaseCandidates,
        nowMs,
      );
      if (leasePartition.preferred.length > 0 && leasePartition.avoided.length > 0) {
        for (const item of leasePartition.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.avoidedByInflightLease = true;
          target.reason = `通道忙碌中，优先避让（${resolveLeaseAvoidWindowSec(item.leaseUntil, nowMs)} 秒租约）`;
        }
        summary.push(`并发占用避让 ${leasePartition.avoided.length}`);
      }

      const ordered = this.getRoundRobinCandidates(
        leasePartition.preferred.length > 0
          ? leasePartition.preferred
          : accountLeaseCandidates,
      );
      let selected: RouteChannelCandidate | null = null;

      for (let index = 0; index < ordered.length; index += 1) {
        const target = candidateMap.get(ordered[index].channel.id);
        if (!target || !target.eligible) continue;
        target.probability = index === 0 ? 100 : 0;
        const baseReason = index === 0
          ? `轮询命中（全局第 1 / ${ordered.length} 位，忽略优先级）`
          : `轮询排队中（全局第 ${index + 1} / ${ordered.length} 位，忽略优先级）`;
        target.reason = target.modelCircuitStatus?.isHalfOpen
          ? `${baseReason}；${target.modelCircuitStatus.reason}`
          : baseReason;
        if (index === 0) {
          selected = ordered[index];
        }
      }

      if (!selected) {
        summary.push('本次未选出通道');
        return {
          requestedModel,
          actualModel: mappedModel,
          matched: true,
          routeId: match.route.id,
          modelPattern: match.route.modelPattern,
          summary,
          candidates,
        };
      }

      const selectedChannel = candidateMap.get(selected.channel.id);
      const selectedLabel = selectedChannel
        ? `${selectedChannel.username} @ ${selectedChannel.siteName} / ${selectedChannel.tokenName}`
        : `channel-${selected.channel.id}`;
      const actualModel = resolveActualModelForSelectedChannel(
        requestedModel,
        match.route,
        mappedModel,
        selected.channel.sourceModel,
      );
      summary.push(`全局轮询：可用 ${ordered.length}，忽略优先级`);
      if (stickyPreference.stickyReason === 'reused' && stickyPreference.stickyBinding) {
        summary.push(`账号粘性复用 ${stickyPreference.stickyBinding.accountId}`);
      }
      summary.push(`最终选择：${selectedLabel}`);
      if (actualModel !== mappedModel) {
        summary.push(`实际转发模型：${actualModel}`);
      }

      return {
        requestedModel,
        actualModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        selectedChannelId: selected.channel.id,
        selectedAccountId: selected.account.id,
        selectedLabel,
        summary,
        candidates,
      };
    }

    const sortedPriorities = Array.from(availableByPriority.keys()).sort((a, b) => a - b);
    let degradedAcrossPriorityByRecentFailure = false;
    let selected: RouteChannelCandidate | null = null;
    let selectedPriority = 0;

    for (const priority of sortedPriorities) {
      const rawLayer = availableByPriority.get(priority) ?? [];
      if (rawLayer.length === 0) continue;

      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawLayer, runtimeModelResolver, nowMs);
      const fullyBlockedByRuntimeBreaker =
        breakerFiltered.avoided.length > 0 && breakerFiltered.candidates.length === rawLayer.length;
      if (breakerFiltered.avoided.length > 0) {
        for (const item of breakerFiltered.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.eligible = false;
          target.reason = item.reason;
          target.circuitStatus = {
            state: 'open',
            isOpen: true,
            reason: item.reason,
          };
        }
      }
      if (fullyBlockedByRuntimeBreaker) {
        const breakerSummaryLabel = breakerFiltered.avoided.some((item) => item.reason.includes('模型熔断'))
          ? '运行时熔断避让'
          : '站点熔断避让';
        summary.push(`优先级 P${priority}：${breakerSummaryLabel} ${breakerFiltered.avoided.length}`);
        continue;
      }

      const recentFailurePartition = partitionRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      const avoided = recentFailurePartition.avoided;
      if (avoided.length > 0) {
        for (const row of avoided) {
          const target = candidateMap.get(row.channel.id);
          if (!target) continue;
          target.avoidedByRecentFailure = true;
          const avoidWindowSec = Math.max(
            60,
            Math.trunc(resolveWeightedFailureCooldownMs(
              Math.max(1, row.channel.consecutiveFailCount ?? row.channel.failCount ?? 1),
              'server',
            ) / 1000),
          );
          target.reason = `最近失败，优先避让（${avoidWindowSec} 秒窗口）`;
        }
      }
      if (recentFailurePartition.preferred.length === 0 && recentFailurePartition.avoided.length > 0) {
        degradedAcrossPriorityByRecentFailure = true;
        summary.push(`优先级 P${priority}：全部候选近期失败，当前避让中`);
        continue;
      }

      const stickyLayer = preferStickySessionCandidates(
        recentFailurePartition.preferred,
        downstreamPolicy.stickySessionKey,
        nowMs,
      );
      const stickyCandidates = stickyLayer.preferred.length > 0
        ? stickyLayer.preferred
        : recentFailurePartition.preferred;
      const accountLeasePartition = partitionAccountSelectionLeases(stickyCandidates, nowMs);
      if (accountLeasePartition.avoided.length > 0) {
        for (const item of accountLeasePartition.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.avoidedByAccountLease = true;
          target.reason = buildAccountRateLimitReason(item, nowMs);
        }
      }
      const candidateLayerSource = accountLeasePartition.preferred;
      const leasePartition = partitionChannelSelectionLeases(candidateLayerSource, nowMs);
      if (leasePartition.preferred.length > 0 && leasePartition.avoided.length > 0) {
        for (const item of leasePartition.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.avoidedByInflightLease = true;
          target.reason = `通道忙碌中，优先避让（${resolveLeaseAvoidWindowSec(item.leaseUntil, nowMs)} 秒租约）`;
        }
      }
      const candidateLayer = leasePartition.preferred.length > 0
        ? leasePartition.preferred
        : candidateLayerSource;
      const selectionPools = buildCandidateSelectionPools(candidateLayer, mappedModel, nowMs);
      let selectedPool: CandidateSelectionPool | null = null;
      for (const pool of selectionPools.pools) {
        if (pool.candidates.length === 0) continue;
        selectedPool = pool;
        break;
      }
      if (!selectedPool) continue;

      const selectedPoolChannelIds = new Set(selectedPool.candidates.map((candidate) => candidate.channel.id));
      for (const pool of selectionPools.pools) {
        if (pool.scope === selectedPool.scope) continue;
        const poolDescription = describeCandidatePoolScope(pool.scope);
        for (const row of pool.candidates) {
          if (selectedPoolChannelIds.has(row.channel.id)) continue;
          const target = candidateMap.get(row.channel.id);
          if (!target || !target.eligible || target.avoidedByRecentFailure) continue;
          target.reason = poolDescription.avoidedReason;
        }
      }

      const weighted = this.calculateWeightedSelection(
        selectedPool.candidates,
        useChannelSourceModelForCost ? runtimeModelResolver : mappedModel,
        downstreamPolicy,
        nowMs,
        routeStrategy === 'stable_first' ? 'stable_first' : 'weighted',
      );
      for (const detail of weighted.details) {
        const target = candidateMap.get(detail.candidate.channel.id);
        if (!target) continue;
        target.probability = Number((detail.probability * 100).toFixed(2));
        if (target.eligible && !target.avoidedByRecentFailure) {
          target.reason = detail.reason;
        }
      }

      if (!weighted.selected) continue;
      selected = weighted.selected;
      selectedPriority = priority;
      const layerSummaryParts = [`优先级 P${priority}：可用 ${rawLayer.length}`];
      if (breakerFiltered.avoided.length > 0) {
        const breakerSummaryLabel = breakerFiltered.avoided.some((item) => item.reason.includes('模型熔断'))
          ? '运行时熔断避让'
          : '站点熔断避让';
        layerSummaryParts.push(`${breakerSummaryLabel} ${breakerFiltered.avoided.length}`);
      }
      if (avoided.length > 0) {
        layerSummaryParts.push(`最近失败避让 ${avoided.length}`);
      }
      if (leasePartition.preferred.length > 0 && leasePartition.avoided.length > 0) {
        layerSummaryParts.push(`并发占用避让 ${leasePartition.avoided.length}`);
      }
      if (accountLeasePartition.avoided.length > 0) {
        layerSummaryParts.push(`${buildAccountAvoidanceSummaryLabel(accountLeasePartition.avoided)} ${accountLeasePartition.avoided.length}`);
      }
      layerSummaryParts.push(describeCandidatePoolScope(selectedPool.scope).summaryLabel);
      if (selectionPools.sitePartition.preferredSiteIds.size > 0 && selectionPools.sitePartition.avoided.length > 0) {
        layerSummaryParts.push(`成功站点池复用 ${selectionPools.sitePartition.preferredSiteIds.size}`);
      }
      if (stickyLayer.stickyReason === 'reused' && stickyLayer.stickyBinding) {
        layerSummaryParts.push(`账号粘性复用 ${stickyLayer.stickyBinding.accountId}`);
      }
      if (degradedAcrossPriorityByRecentFailure) {
        layerSummaryParts.push('上层最近失败，已自动降级');
      }
      summary.push(layerSummaryParts.join('，'));
      break;
    }

    if (!selected) {
      summary.push('本次未选出通道');
      return {
        requestedModel,
        actualModel: mappedModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        summary,
        candidates,
      };
    }

    const selectedChannel = candidateMap.get(selected.channel.id);
    const selectedLabel = selectedChannel
      ? `${selectedChannel.username} @ ${selectedChannel.siteName} / ${selectedChannel.tokenName}`
      : `channel-${selected.channel.id}`;
    const actualModel = resolveActualModelForSelectedChannel(
      requestedModel,
      match.route,
      mappedModel,
      selected.channel.sourceModel,
    );
    summary.push(`最终选择：${selectedLabel}（P${selectedPriority}）`);
    if (actualModel !== mappedModel) {
      summary.push(`实际转发模型：${actualModel}`);
    }

    return {
      requestedModel,
      actualModel,
      matched: true,
      routeId: match.route.id,
      modelPattern: match.route.modelPattern,
      selectedChannelId: selected.channel.id,
      selectedAccountId: selected.account.id,
      selectedLabel,
      summary,
      candidates,
    };
  }

  private async refreshPricingReferenceCostsForMatch(
    match: RouteMatch | null,
    requestedModel: string,
    options: PricingReferenceRefreshOptions = {},
  ): Promise<void> {
    if (!match) return;

    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const useChannelSourceModelForCost = (options.useChannelSourceModelForCost ?? false) || requestedByDisplayName;
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const refreshedKeys = options.refreshedKeys ?? new Set<string>();

    await Promise.allSettled(match.channels.map(async (candidate) => {
      const refreshKey = `${candidate.site.id}:${candidate.account.id}`;
      if (refreshedKeys.has(refreshKey)) return;
      refreshedKeys.add(refreshKey);

      const modelName = useChannelSourceModelForCost
        ? (normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
        : mappedModel;
      if (!modelName) return;

      await refreshModelPricingCatalog({
        site: {
          id: candidate.site.id,
          url: candidate.site.url,
          platform: candidate.site.platform,
          apiKey: candidate.site.apiKey,
        },
        account: {
          id: candidate.account.id,
          accessToken: candidate.account.accessToken,
          apiToken: candidate.account.apiToken,
        },
        modelName,
      });
    }));
  }

  /**
   * Record success for a channel.
   */
  async recordSuccess(channelId: number, latencyMs: number, cost: number, modelName?: string | null) {
    await ensureRoutingRuntimeStateLoaded();
    const row = await db.select()
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .where(eq(schema.routeChannels.id, channelId))
      .get();
    if (!row) return;
    const ch = row.route_channels;
    const account = row.accounts;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const nextSuccessCount = (ch.successCount ?? 0) + 1;
    const nextTotalLatencyMs = (ch.totalLatencyMs ?? 0) + latencyMs;
    const nextTotalCost = (ch.totalCost ?? 0) + cost;
    await db.update(schema.routeChannels).set({
      successCount: nextSuccessCount,
      totalLatencyMs: nextTotalLatencyMs,
      totalCost: nextTotalCost,
      lastUsedAt: nowIso,
      cooldownUntil: null,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).where(eq(schema.routeChannels.id, channelId)).run();

    patchCachedChannel(channelId, (channel) => {
      channel.successCount = nextSuccessCount;
      channel.totalLatencyMs = nextTotalLatencyMs;
      channel.totalCost = nextTotalCost;
      channel.lastUsedAt = nowIso;
      channel.cooldownUntil = null;
      channel.lastFailAt = null;
      channel.consecutiveFailCount = 0;
      channel.cooldownLevel = 0;
    });
    releaseChannelSelectionLease(channelId);
    releaseAccountSelectionLease(account.id, nowMs);

    await restorePersistedModelAvailabilityForChannel(ch, account.id, modelName);
    const normalizedSuccessfulModel = normalizeModelAlias(modelName || '');
    if (normalizedSuccessfulModel && (!normalizeChannelSourceModel(ch.sourceModel) || ch.sourceModelDerived)) {
      await db.update(schema.routeChannels).set({
        sourceModel: normalizedSuccessfulModel,
      }).where(eq(schema.routeChannels.id, channelId)).run();
      patchCachedChannel(channelId, (channel) => {
        channel.sourceModel = normalizedSuccessfulModel;
        (channel as typeof channel & { sourceModelDerived?: boolean }).sourceModelDerived = false;
      });
    }
    if (typeof ch.tokenId === 'number' && ch.tokenId > 0) {
      await clearRoutingGovernanceState('token', ch.tokenId, null);
      if (normalizeModelAlias(modelName || '')) {
        await clearRoutingGovernanceState('token', ch.tokenId, modelName);
      }
    }
    await clearRoutingGovernanceState('account', account.id, null);
    if (normalizeModelAlias(modelName || '')) {
      await clearRoutingGovernanceState('account', account.id, modelName);
    }
    await clearRoutingGovernanceState('channel', ch.id, null);
    await clearRoutingGovernanceState('site', account.siteId, null);

    if (normalizeModelAlias(modelName || '')) {
      recordModelCircuitSuccess(channelId, modelName || '', nowMs);
    }
    recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName, nowMs);
    const accountState = getOrCreateAccountRoutingState(account.id, nowMs);
    accountState.successEma = (
      accountState.lastSuccessAtMs == null && accountState.lastFailureAtMs == null
        ? 1
        : ((accountState.successEma * (1 - ACCOUNT_SUCCESS_EMA_ALPHA)) + ACCOUNT_SUCCESS_EMA_ALPHA)
    );
    accountState.latencyEmaMs = accountState.latencyEmaMs == null
      ? latencyMs
      : ((accountState.latencyEmaMs * (1 - ACCOUNT_LATENCY_EMA_ALPHA)) + (latencyMs * ACCOUNT_LATENCY_EMA_ALPHA));
    accountState.lastSuccessAtMs = nowMs;
    accountState.consecutiveFailures = 0;
    accountState.updatedAtMs = nowMs;
    const stickyKey = stickySessionKeyByChannel.get(channelId);
    if (stickyKey) {
      const binding = stickySessionBindings.get(stickyKey);
      if (binding) {
        binding.accountId = account.id;
        binding.lastUsedAtMs = nowMs;
        binding.expiresAtMs = Math.max(binding.expiresAtMs, nowMs + ACCOUNT_STICKY_BINDING_TTL_MS);
      }
    }
    const budgetState = syncAccountRateBudgetConfig(account.id, nowMs);
    budgetState.capacity = resolveAccountRateLimitCapacity(accountState);
    budgetState.refillPerSec = resolveAccountRateLimitRefillPerSec(accountState);
    budgetState.tokens = clampNumber(budgetState.tokens + 0.4, 0, budgetState.capacity);
    budgetState.denyUntilMs = null;
    budgetState.updatedAtMs = nowMs;
    scheduleAccountRuntimePersistence();
  }

  /**
   * Record failure and set cooldown.
   */
  async recordFailure(channelId: number, context: SiteRuntimeFailureContext | string | null = {}) {
    await ensureRoutingRuntimeStateLoaded();
    const row = await db.select()
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(eq(schema.routeChannels.id, channelId))
      .get();
    if (!row) return;

    const ch = row.route_channels;
    const account = row.accounts;
    const route = row.token_routes;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const normalizedContext: SiteRuntimeFailureContext = typeof context === 'string'
      ? { modelName: context }
      : (context ?? {});
    const retryAfterMs = resolveRetryAfterMsFromContext(normalizedContext, nowMs);
    const retryAfterUntil = retryAfterMs != null && retryAfterMs > 0
      ? new Date(nowMs + retryAfterMs).toISOString()
      : null;
    const shortWindowLimitCooldownUntil = resolveShortWindowLimitCooldownUntil(account, normalizedContext, nowMs);
    const failCount = shortWindowLimitCooldownUntil ? 0 : ((ch.failCount ?? 0) + 1);
    const isProtocolFailure = matchesAnyPattern(SITE_PROTOCOL_FAILURE_PATTERNS, normalizedContext.errorText);
    const routeStrategy = resolveRouteStrategy(route);
    const affectedChannelIds = shortWindowLimitCooldownUntil
      ? await loadCredentialScopedChannelIds(ch, account)
      : [channelId];
    let cooldownUntil: string | null = null;
    let consecutiveFailCount = Math.max(0, ch.consecutiveFailCount ?? 0) + 1;
    let cooldownLevel = Math.max(0, ch.cooldownLevel ?? 0);
    const failureCategory = classifyProxyFailureCategory(normalizedContext.status, normalizedContext.errorText);

    if (shortWindowLimitCooldownUntil) {
      cooldownUntil = shortWindowLimitCooldownUntil;
      consecutiveFailCount = 0;
      cooldownLevel = 0;
    } else if (routeStrategy === 'round_robin') {
      if (shouldApplyImmediateRoundRobinCooldown(failureCategory)) {
        cooldownLevel = Math.max(
          cooldownLevel,
          resolveWeightedFailureCooldownLevel(consecutiveFailCount, failureCategory),
        );
        const cooldownMs = resolveWeightedFailureCooldownMs(consecutiveFailCount, failureCategory);
        cooldownUntil = cooldownMs > 0 ? new Date(nowMs + cooldownMs).toISOString() : null;
      } else if (consecutiveFailCount >= ROUND_ROBIN_FAILURE_THRESHOLD) {
        cooldownLevel = Math.min(cooldownLevel + 1, 3);
        const cooldownMs = resolveRoundRobinCooldownMs(cooldownLevel);
        cooldownUntil = cooldownMs > 0 ? new Date(nowMs + cooldownMs).toISOString() : null;
        consecutiveFailCount = 0;
      }
    } else {
      cooldownLevel = Math.max(
        cooldownLevel,
        resolveWeightedFailureCooldownLevel(consecutiveFailCount, failureCategory),
      );
      const cooldownMs = resolveWeightedFailureCooldownMs(consecutiveFailCount, failureCategory);
      cooldownUntil = new Date(nowMs + cooldownMs).toISOString();
    }

    const authCooldownSec = resolveAuthFailureCooldownSec(normalizedContext);
    if (authCooldownSec > 0) {
      const authCooldownUntil = new Date(nowMs + authCooldownSec * 1000).toISOString();
      if (!cooldownUntil || authCooldownUntil > cooldownUntil) {
        cooldownUntil = authCooldownUntil;
      }
    }
    if (retryAfterUntil && (!cooldownUntil || retryAfterUntil > cooldownUntil)) {
      cooldownUntil = retryAfterUntil;
    }
    const extendedCooldownMs = resolveExtendedChannelCooldownMs(normalizedContext);
    if (extendedCooldownMs > 0) {
      const extendedCooldownUntil = new Date(nowMs + extendedCooldownMs).toISOString();
      if (!cooldownUntil || extendedCooldownUntil > cooldownUntil) {
        cooldownUntil = extendedCooldownUntil;
      }
    }

    await db.update(schema.routeChannels).set({
      failCount,
      lastFailAt: nowIso,
      consecutiveFailCount,
      cooldownLevel,
      cooldownUntil,
    }).where(inArray(schema.routeChannels.id, affectedChannelIds)).run();

    for (const affectedChannelId of affectedChannelIds) {
      patchCachedChannel(affectedChannelId, (channel) => {
        channel.failCount = failCount;
        channel.lastFailAt = nowIso;
        channel.cooldownUntil = cooldownUntil;
        channel.consecutiveFailCount = consecutiveFailCount;
        channel.cooldownLevel = cooldownLevel;
      });
    }
    releaseChannelSelectionLease(channelId);
    releaseAccountSelectionLease(account.id, nowMs);
    clearStickyBindingForChannel(channelId);

    if (failureCategory === 'model_unsupported') {
      await markPersistedModelUnavailableForChannel(ch, account.id, normalizedContext.modelName);
    }

    if (failureCategory === 'auth' && isDefinitiveTokenCredentialFailure(normalizedContext)) {
      await disableDefinitivelyBrokenTokenForChannel(ch);
    }

    const normalizedRuntimeModelName = normalizeModelAlias(normalizedContext.modelName || '');
    if (normalizedRuntimeModelName) {
      if (!shouldSkipModelCircuitForFailure(normalizedContext)) {
        const immediateModelCircuitCategory = shouldOpenImmediateModelCircuitForFailure(normalizedContext);
        if (immediateModelCircuitCategory) {
          openModelCircuitImmediately(
            channelId,
            normalizedRuntimeModelName,
            immediateModelCircuitCategory,
            nowMs,
          );
        } else {
          const modelCircuitFailureCategory: ModelCircuitFailureCategory = failureCategory === 'other'
            ? 'unknown'
            : (failureCategory === 'invalid_channel' || failureCategory === 'upstream_group_empty'
              ? 'bad_request'
              : failureCategory);
          recordModelCircuitFailure(
            channelId,
            normalizedRuntimeModelName,
            modelCircuitFailureCategory,
            nowMs,
          );
        }
      }
    }
    recordSiteRuntimeFailure(account.siteId, normalizedContext, nowMs);
    const accountState = getOrCreateAccountRoutingState(account.id, nowMs);
    accountState.successEma = (
      accountState.lastSuccessAtMs == null && accountState.lastFailureAtMs == null
        ? 0
        : (accountState.successEma * (1 - ACCOUNT_SUCCESS_EMA_ALPHA))
    );
    accountState.lastFailureAtMs = nowMs;
    accountState.consecutiveFailures += 1;
    accountState.updatedAtMs = nowMs;
    const budgetState = syncAccountRateBudgetConfig(account.id, nowMs);
    budgetState.capacity = resolveAccountRateLimitCapacity(accountState);
    budgetState.refillPerSec = resolveAccountRateLimitRefillPerSec(accountState);
    budgetState.tokens = clampNumber(budgetState.tokens * 0.6, 0, budgetState.capacity);
    if (retryAfterMs != null && retryAfterMs > 0) {
      budgetState.denyUntilMs = Math.max(
        budgetState.denyUntilMs ?? 0,
        nowMs + retryAfterMs,
      );
    }
    if (!isProtocolFailure && (failureCategory === 'auth' || failureCategory === 'rate_limit')) {
      budgetState.denyUntilMs = Math.max(
        budgetState.denyUntilMs ?? 0,
        nowMs + Math.max(30_000, resolveWeightedFailureCooldownMs(Math.max(1, consecutiveFailCount), failureCategory)),
      );
    }
    budgetState.updatedAtMs = nowMs;
    scheduleAccountRuntimePersistence();

    const governanceSuppression = resolveGovernanceSuppression({
      failureCategory,
      channel: ch,
      account,
      status: normalizedContext.status,
      modelName: normalizedContext.modelName,
      errorText: normalizedContext.errorText,
      cooldownUntil,
    });
    if (governanceSuppression) {
      await upsertRoutingGovernanceState({
        subjectType: governanceSuppression.subjectType,
        subjectId: governanceSuppression.subjectId,
        modelName: governanceSuppression.modelName,
        state: 'suppressed',
        reasonCode: governanceSuppression.reasonCode,
        reasonDetail: (normalizedContext.errorText || '').trim() || null,
        probeModelName: normalizeModelAlias(normalizedContext.modelName || '') || null,
        lastHttpStatus: typeof normalizedContext.status === 'number' ? normalizedContext.status : null,
        suppressUntil: cooldownUntil,
        probeAfter: cooldownUntil,
        lastFailureAt: nowIso,
        failureCountDelta: 1,
      });

      const governanceModelName = normalizeModelAlias(normalizedContext.modelName || '') || normalizedContext.modelName || null;
      const suppressUntil = cooldownUntil ?? retryAfterUntil ?? null;
      await db.insert(schema.events).values({
        type: 'proxy',
        title: '路由治理抑制生效',
        message: [
          `failureCategory=${failureCategory}`,
          'governanceAction=suppressed',
          `subjectType=${governanceSuppression.subjectType}`,
          `subjectId=${governanceSuppression.subjectId}`,
          `modelName=${governanceModelName || '-'}`,
          `reasonCode=${governanceSuppression.reasonCode}`,
          `suppressUntil=${suppressUntil || '-'}`,
          'lastProbeStatus=passive_wait',
        ].join(', '),
        level: 'warning',
        relatedId: governanceSuppression.subjectId,
        relatedType: governanceSuppression.subjectType,
        createdAt: formatUtcSqlDateTime(new Date(nowMs)),
      }).run();
    }
  }

  /**
   * Get all available models (aggregated from all routes).
   */
  async getAvailableModels(downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY): Promise<string[]> {
    const routes = await loadEnabledRoutes();
    const publicSurfaceOnly = downstreamPolicy.publicRoutesOnly === true;
    const exposedNames = Array.from(new Set(
      (publicSurfaceOnly
        ? routes.filter((route) => route.enabled && isExplicitGroupRoute(route) && normalizeRouteDisplayName(route.displayName).length > 0)
        : buildVisibleEnabledRoutesForPolicy(routes, downstreamPolicy)
      )
        .map((route) => getExposedModelNameForRoute(route).trim())
        .filter((name) => name.length > 0),
    ));

    const resolutionPolicy = publicSurfaceOnly
      ? DEFAULT_DOWNSTREAM_POLICY
      : downstreamPolicy;
    const routable: string[] = [];
    for (const modelName of exposedNames) {
      const match = await this.findRoute(modelName, resolutionPolicy);
      if (!match) continue;
      const selected = await this.selectFromMatch(match, modelName, resolutionPolicy, [], false);
      if (selected) {
        routable.push(modelName);
      }
    }
    return routable;
  }

  // --- Private methods ---

  private async selectFromMatch(
    match: RouteMatch,
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy,
    excludeChannelIds: number[] = [],
    recordSelection = true,
    excludeSiteIds: ReadonlySet<number> = new Set<number>(),
  ): Promise<SelectedChannel | null> {
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const bypassSourceModelCheck = requestedByDisplayName;
    const routeStrategy = resolveRouteStrategy(match.route);
    const runtimeModelResolver = requestedByDisplayName
      ? ((candidate: RouteChannelCandidate) => normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
      : mappedModel;
    const persistedUnavailableModels = await loadPersistedUnavailableModelsForCandidates(match.channels);
    const governanceSnapshot = await loadGovernanceSnapshotForCandidates(match.channels);

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const effectiveExcludeSiteIds = buildExcludedSiteIdsFromMatch(match, excludeChannelIds, excludeSiteIds);
    const evaluatedCandidates = match.channels.map((candidate) => {
      const runtimeModelName = typeof runtimeModelResolver === 'function'
        ? runtimeModelResolver(candidate)
        : runtimeModelResolver;
      const governanceBlock = findGovernanceBlockFromSnapshot(
        governanceSnapshot,
        candidate,
        runtimeModelName,
      );
      const reasons = this.getCandidateEligibilityReasons(candidate, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        excludeSiteIds: effectiveExcludeSiteIds,
        nowIso,
        nowMs,
        runtimeModelName,
        persistedUnavailableModels,
        governanceSnapshot,
      });
      return {
        candidate,
        reasons,
        governanceBlock,
      };
    });
    const available = evaluatedCandidates
      .filter((entry) => entry.reasons.length === 0)
      .map((entry) => entry.candidate);
    if (available.length === 0) return null;

    if (routeStrategy === 'round_robin') {
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(available, runtimeModelResolver, nowMs);
      const fullyBlockedByRuntimeBreaker =
        breakerFiltered.avoided.length > 0 && breakerFiltered.candidates.length === available.length;
      if (fullyBlockedByRuntimeBreaker) return null;
      const stickyPreference = preferStickySessionCandidates(
        breakerFiltered.candidates,
        downstreamPolicy.stickySessionKey,
        nowMs,
      );
      const stickyCandidates = stickyPreference.preferred.length > 0
        ? stickyPreference.preferred
        : breakerFiltered.candidates;
      const recentFailurePartition = partitionRecentlyFailedCandidates(stickyCandidates, nowMs);
      if (recentFailurePartition.preferred.length === 0 && recentFailurePartition.avoided.length > 0) {
        return null;
      }
      const recoveryCandidates = recentFailurePartition.preferred;
      const accountLeasePartition = partitionAccountSelectionLeases(recoveryCandidates, nowMs);
      const accountLeaseCandidates = accountLeasePartition.preferred;
      const leasePartition = partitionChannelSelectionLeases(
        accountLeaseCandidates,
        nowMs,
      );
      const selectionPool = leasePartition.preferred.length > 0
        ? leasePartition.preferred
        : accountLeaseCandidates;
      const selected = this.selectWithModelCircuitGuard(
        selectionPool,
        (items) => this.selectRoundRobinCandidate(items),
        (candidate) => (
          typeof runtimeModelResolver === 'function'
            ? runtimeModelResolver(candidate)
            : runtimeModelResolver
        ),
        nowMs,
        recordSelection,
      );
      if (!selected) return null;

      const tokenValue = this.resolveChannelTokenValue(selected);
      if (!tokenValue) return null;
      if (recordSelection) {
        await this.recordChannelSelection(selected.channel.id);
        const leaseMs = resolveChannelSelectionLeaseMs(selected);
        reserveChannelSelectionLease(selected.channel.id, nowMs, leaseMs);
        reserveAccountSelectionLease(selected, nowMs, leaseMs);
        bindStickySessionToCandidate(downstreamPolicy.stickySessionKey, selected, nowMs, leaseMs);
      }

      const actualModel = resolveActualModelForSelectedChannel(
        requestedModel,
        match.route,
        mappedModel,
        selected.channel.sourceModel,
      );

      return {
        ...selected,
        tokenValue,
        tokenName: selected.token?.name || 'default',
        actualModel,
      };
    }

    const layers = new Map<number, typeof available>();
    for (const candidate of available) {
      const priority = candidate.channel.priority ?? 0;
      if (!layers.has(priority)) layers.set(priority, []);
      layers.get(priority)!.push(candidate);
    }

    const sortedPriorities = Array.from(layers.keys()).sort((a, b) => a - b);
    for (const priority of sortedPriorities) {
      const rawLayer = layers.get(priority) ?? [];
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawLayer, runtimeModelResolver, nowMs);
      const fullyBlockedByRuntimeBreaker =
        breakerFiltered.avoided.length > 0 && breakerFiltered.candidates.length === rawLayer.length;
      if (fullyBlockedByRuntimeBreaker) {
        continue;
      }
      const recentFailurePartition = partitionRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      if (recentFailurePartition.preferred.length === 0 && recentFailurePartition.avoided.length > 0) {
        continue;
      }
      const stickyLayer = preferStickySessionCandidates(
        recentFailurePartition.preferred,
        downstreamPolicy.stickySessionKey,
        nowMs,
      );
      const stickyCandidates = stickyLayer.preferred.length > 0
        ? stickyLayer.preferred
        : recentFailurePartition.preferred;
      const accountLeasePartition = partitionAccountSelectionLeases(stickyCandidates, nowMs);
      const candidateLayerSource = accountLeasePartition.preferred;
      const leasePartition = partitionChannelSelectionLeases(candidateLayerSource, nowMs);
      const candidateLayer = leasePartition.preferred.length > 0
        ? leasePartition.preferred
        : candidateLayerSource;
      const selectionPools = buildCandidateSelectionPools(candidateLayer, mappedModel, nowMs);
      let selectedPool: CandidateSelectionPool | null = null;
      for (const pool of selectionPools.pools) {
        if (pool.candidates.length === 0) continue;
        selectedPool = pool;
        break;
      }
      if (!selectedPool) continue;

      const selected = routeStrategy === 'stable_first'
        ? this.selectWithModelCircuitGuard(
          selectedPool.candidates,
          (items) => this.stableFirstSelect(
            items,
            requestedByDisplayName ? runtimeModelResolver : mappedModel,
            downstreamPolicy,
            nowMs,
          ),
          (candidate) => (
            requestedByDisplayName && typeof runtimeModelResolver === 'function'
              ? runtimeModelResolver(candidate)
              : mappedModel
          ),
          nowMs,
          recordSelection,
        )
        : this.selectWithModelCircuitGuard(
          selectedPool.candidates,
          (items) => this.weightedRandomSelect(
            items,
            requestedByDisplayName ? runtimeModelResolver : mappedModel,
            downstreamPolicy,
            nowMs,
          ),
          (candidate) => (
            requestedByDisplayName && typeof runtimeModelResolver === 'function'
              ? runtimeModelResolver(candidate)
              : mappedModel
          ),
          nowMs,
          recordSelection,
        );
      if (!selected) continue;

      const tokenValue = this.resolveChannelTokenValue(selected);
      if (!tokenValue) continue;
      if (routeStrategy === 'stable_first' && recordSelection) {
        await this.recordChannelSelection(selected.channel.id);
      }
      if (recordSelection) {
        const leaseMs = resolveChannelSelectionLeaseMs(selected);
        reserveChannelSelectionLease(selected.channel.id, nowMs, leaseMs);
        reserveAccountSelectionLease(selected, nowMs, leaseMs);
        bindStickySessionToCandidate(downstreamPolicy.stickySessionKey, selected, nowMs, leaseMs);
      }

      const actualModel = resolveActualModelForSelectedChannel(
        requestedModel,
        match.route,
        mappedModel,
        selected.channel.sourceModel,
      );

      return {
        ...selected,
        tokenValue,
        tokenName: selected.token?.name || 'default',
        actualModel,
      };
    }

    return null;
  }

  private async findRoute(model: string, downstreamPolicy: DownstreamRoutingPolicy): Promise<RouteMatch | null> {
    let routes = await loadEnabledRoutes();
    if (downstreamPolicy.publicRoutesOnly === true) {
      routes = buildVisibleEnabledRoutes(routes);
    }

    const globalAllowedPatterns = Array.isArray(downstreamPolicy.globalAllowedModels)
      ? downstreamPolicy.globalAllowedModels
      : [];
    if (globalAllowedPatterns.length > 0 && !globalAllowedPatterns.some((pattern) => matchesModelPattern(model, pattern))) {
      return null;
    }

    const supportedPatterns = Array.isArray(downstreamPolicy.supportedModels)
      ? downstreamPolicy.supportedModels
      : [];
    const matchedSupportedPattern = supportedPatterns.some((pattern) => matchesModelPattern(model, pattern));

    if (downstreamPolicy.allowedRouteIds.length > 0 && !matchedSupportedPattern) {
      const allowSet = new Set(downstreamPolicy.allowedRouteIds);
      routes = routes.filter((route) => allowSet.has(route.id));
    }

    const matchedRoute = findPreferredRouteForModel(routes, model);

    if (!matchedRoute) return null;

    return await this.loadRouteMatch(matchedRoute);
  }

  private async findRouteById(routeId: number, downstreamPolicy: DownstreamRoutingPolicy): Promise<RouteMatch | null> {
    const route = (await loadEnabledRoutes()).find((item) => item.id === routeId);
    if (!route) return null;

    const exposedName = getExposedModelNameForRoute(route).trim();
    const globalAllowedPatterns = Array.isArray(downstreamPolicy.globalAllowedModels)
      ? downstreamPolicy.globalAllowedModels
      : [];
    if (globalAllowedPatterns.length > 0 && !globalAllowedPatterns.some((pattern) => matchesModelPattern(exposedName, pattern))) {
      return null;
    }

    if (downstreamPolicy.allowedRouteIds.length > 0 && !downstreamPolicy.allowedRouteIds.includes(routeId)) {
      return null;
    }

    return await this.loadRouteMatch(route);
  }

  private async loadRouteMatch(route: RouteRow): Promise<RouteMatch> {
    return await loadRouteMatch(route);
  }

  private resolveChannelTokenValue(candidate: {
    channel: typeof schema.routeChannels.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    site?: typeof schema.sites.$inferSelect | null;
    token: typeof schema.accountTokens.$inferSelect | null;
  }): string | null {
    if (candidate.channel.tokenId) {
      if (!candidate.token) return null;
      if (!isUsableAccountToken(candidate.token)) return null;
      const token = candidate.token.token?.trim();
      return token ? token : null;
    }

    if (getOauthInfoFromExtraConfig(candidate.account.extraConfig)) {
      const accessToken = candidate.account.accessToken?.trim();
      if (accessToken) return accessToken;
      return null;
    }

    const fallback = candidate.account.apiToken?.trim();
    if (fallback) return fallback;

    return null;
  }

  private getCandidateEligibilityReasons(
    candidate: RouteChannelCandidate,
    options: CandidateEligibilityOptions,
  ): string[] {
    const reasonParts: string[] = [];
    const bypassSourceModelCheck = options.bypassSourceModelCheck ?? false;
    const excludeChannelIds = options.excludeChannelIds ?? [];
    const excludeSiteIds = options.excludeSiteIds ?? new Set<number>();
    const nowIso = options.nowIso ?? new Date().toISOString();
    const nowMs = options.nowMs ?? Date.now();

    if (!bypassSourceModelCheck && !channelSupportsRequestedModel(candidate.channel.sourceModel, options.requestedModel)) {
      reasonParts.push(`来源模型不匹配=${candidate.channel.sourceModel || ''}`);
    }

    if (isCandidatePersistentlyUnavailableForModel(
      candidate,
      options.runtimeModelName,
      options.persistedUnavailableModels,
      nowMs,
    )) {
      reasonParts.push('模型能力已标记不可用');
    }

    const governanceBlock = findGovernanceBlockFromSnapshot(
      options.governanceSnapshot,
      candidate,
      options.runtimeModelName,
    );
    if (governanceBlock && governanceBlock.state === 'suppressed') {
      reasonParts.push(formatGovernanceReason(governanceBlock));
    }

    if (!candidate.channel.enabled) {
      reasonParts.push('通道禁用');
    }

    const isExplicitToken = isExplicitTokenChannel(candidate);
    const runtimeHealth = extractRuntimeHealth(candidate.account.extraConfig);
    const ignoreExpiredStatusForExplicitToken = isExplicitToken && candidate.account.status === 'expired';

    if (candidate.account.status !== 'active' && !ignoreExpiredStatusForExplicitToken) {
      reasonParts.push(`账号状态=${candidate.account.status}`);
    }

    if (runtimeHealth?.state === 'disabled' || runtimeHealth?.state === 'unhealthy') {
      reasonParts.push(`运行时健康=${runtimeHealth.state}`);
    }

    if (isSiteDisabled(candidate.site.status)) {
      reasonParts.push(`站点状态=${candidate.site.status || 'disabled'}`);
    }

    if (!isSiteReachableForRouting(candidate.site)) {
      reasonParts.push('站点健康=unreachable');
    }

    if (excludeChannelIds.includes(candidate.channel.id)) {
      reasonParts.push('当前请求已尝试');
    }

    if (excludeSiteIds.has(candidate.site.id)) {
      reasonParts.push('当前请求站点已失败');
    }

    const tokenValue = this.resolveChannelTokenValue(candidate);
    if (!tokenValue) {
      reasonParts.push('令牌不可用');
    }

    if (candidate.channel.cooldownUntil && candidate.channel.cooldownUntil > nowIso) {
      reasonParts.push('冷却中');
    }

    if (shouldSoftParkUnknownCapabilityCandidate(
      candidate,
      options.requestedModel,
      options.governanceBlock,
      nowMs,
    )) {
      reasonParts.push('模型能力未验证且近期失败，已软停放');
    }

    const modelCircuitStatus = getCandidateModelCircuitStatus(
      candidate.channel.id,
      options.runtimeModelName,
      nowMs,
    );
    if (modelCircuitStatus?.isOpen) {
      reasonParts.push('模型熔断中');
    }

    return reasonParts;
  }

  private getRoundRobinCandidates(candidates: RouteChannelCandidate[]): RouteChannelCandidate[] {
    return [...candidates].sort((left, right) => {
      const selectionOrder = compareNullableTimeAsc(
        left.channel.lastSelectedAt || left.channel.lastUsedAt,
        right.channel.lastSelectedAt || right.channel.lastUsedAt,
      );
      if (selectionOrder !== 0) return selectionOrder;

      const usedOrder = compareNullableTimeAsc(left.channel.lastUsedAt, right.channel.lastUsedAt);
      if (usedOrder !== 0) return usedOrder;

      return (left.channel.id ?? 0) - (right.channel.id ?? 0);
    });
  }

  private selectRoundRobinCandidate(candidates: RouteChannelCandidate[]): RouteChannelCandidate | null {
    return this.getRoundRobinCandidates(candidates)[0] ?? null;
  }

  private compareStableFirstCandidates(left: RouteChannelCandidate, right: RouteChannelCandidate): number {
    const selectionOrder = compareNullableTimeAsc(
      left.channel.lastSelectedAt || left.channel.lastUsedAt,
      right.channel.lastSelectedAt || right.channel.lastUsedAt,
    );
    if (selectionOrder !== 0) return selectionOrder;

    const usedOrder = compareNullableTimeAsc(left.channel.lastUsedAt, right.channel.lastUsedAt);
    if (usedOrder !== 0) return usedOrder;

    return (left.channel.id ?? 0) - (right.channel.id ?? 0);
  }

  private async recordChannelSelection(channelId: number): Promise<void> {
    const nowIso = new Date().toISOString();
    await db.update(schema.routeChannels).set({
      lastSelectedAt: nowIso,
    }).where(eq(schema.routeChannels.id, channelId)).run();

    patchCachedChannel(channelId, (channel) => {
      channel.lastSelectedAt = nowIso;
    });
  }

  private selectWithModelCircuitGuard(
    candidates: RouteChannelCandidate[],
    picker: (candidates: RouteChannelCandidate[]) => RouteChannelCandidate | null,
    resolveModelName: (candidate: RouteChannelCandidate) => string,
    nowMs: number,
    reserveHalfOpenProbe: boolean,
  ): RouteChannelCandidate | null {
    const remaining = [...candidates];
    while (remaining.length > 0) {
      const selected = picker(remaining);
      if (!selected) return null;

      const modelName = resolveModelName(selected);
      const modelCircuitStatus = getCandidateModelCircuitStatus(selected.channel.id, modelName, nowMs);
      const canUseCandidate = !modelCircuitStatus?.isHalfOpen
        || !reserveHalfOpenProbe
        || canUseModelCircuit(selected.channel.id, modelName, nowMs);
      if (canUseCandidate) {
        return selected;
      }

      const index = remaining.findIndex((candidate) => candidate.channel.id === selected.channel.id);
      if (index < 0) return null;
      remaining.splice(index, 1);
    }

    return null;
  }

  private weightedRandomSelect(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs = Date.now(),
  ) {
    return this.calculateWeightedSelection(candidates, modelName, downstreamPolicy, nowMs, 'weighted').selected;
  }

  private stableFirstSelect(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs = Date.now(),
  ) {
    return this.calculateWeightedSelection(candidates, modelName, downstreamPolicy, nowMs, 'stable_first').selected;
  }

  private calculateWeightedSelection(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs = Date.now(),
    selectionMode: WeightedSelectionMode = 'weighted',
  ) {
    if (candidates.length === 0) {
      return {
        selected: null as RouteChannelCandidate | null,
        details: [] as Array<{ candidate: RouteChannelCandidate; probability: number; reason: string }>,
      };
    }

    if (candidates.length === 1) {
      return {
        selected: candidates[0],
        details: [{
          candidate: candidates[0],
          probability: 1,
          reason: selectionMode === 'stable_first' ? '稳定优先（唯一可用候选）' : '唯一可用候选',
        }],
      };
    }

    const { baseWeightFactor, valueScoreFactor, costWeight, balanceWeight, usageWeight } = config.routingWeights;
    const resolveModelName = typeof modelName === 'function'
      ? modelName
      : (() => modelName);
    const resolvedModelNames = candidates.map((candidate) => resolveModelName(candidate));
    const effectiveCosts = candidates.map((candidate, index) => resolveEffectiveUnitCost(candidate, resolvedModelNames[index]!));
    const runtimeHealthDetails = candidates.map((candidate, index) => (
      getSiteRuntimeHealthDetails(candidate.site.id, resolvedModelNames[index], nowMs)
    ));
    const modelPreferredSiteIds = new Set<number>();
    const hasModelPreference = new Set<string>();
    for (const runtimeModelName of Array.from(new Set(resolvedModelNames.map((item) => normalizeModelAlias(item)))).filter(Boolean)) {
      const partition = partitionModelPreferredSiteCandidates(candidates, runtimeModelName, nowMs);
      if (partition.source !== 'none') {
        hasModelPreference.add(runtimeModelName);
        for (const siteId of partition.preferredSiteIds) {
          modelPreferredSiteIds.add(siteId);
        }
      }
    }
    const modelCircuitStatuses = candidates.map((candidate, index) => (
      getCandidateModelCircuitStatus(candidate.channel.id, resolvedModelNames[index], nowMs)
    ));
    const stickyPreference = preferStickySessionCandidates(
      candidates,
      downstreamPolicy.stickySessionKey,
      nowMs,
    );
    const accountStates = candidates.map((candidate) => (
      accountRoutingStates.get(candidate.account.id) ?? null
    ));

    const valueScores = candidates.map((c, i) => {
      const unitCost = effectiveCosts[i]?.unitCost || 1;
      const balance = c.account.balance || 0;
      const totalUsed = (c.channel.successCount ?? 0) + (c.channel.failCount ?? 0);
      const recentUsage = Math.max(totalUsed, 1);
      return costWeight * (1 / unitCost) + balanceWeight * balance + usageWeight * (1 / recentUsage);
    });

    const maxVS = Math.max(...valueScores, 0.001);
    const minVS = Math.min(...valueScores, 0);
    const range = maxVS - minVS || 1;
    const normalizedVS = valueScores.map((v) => (v - minVS) / range);

    const baseContributions = candidates.map((c, i) => {
      const weight = c.channel.weight ?? 10;
      return (weight + 10) * (baseWeightFactor + normalizedVS[i] * valueScoreFactor);
    });

    // Avoid over-favoring a site that has many tokens/channels for the same route.
    // Site-level total contribution remains comparable, then split across its channels.
    const siteChannelCounts = new Map<number, number>();
    for (const candidate of candidates) {
      siteChannelCounts.set(candidate.site.id, (siteChannelCounts.get(candidate.site.id) || 0) + 1);
    }
    const siteHistoricalHealthMetrics = buildSiteHistoricalHealthMetrics(candidates);
    const channelHealthScores = candidates.map((candidate) => calculateChannelHealthScore({
      successCount: candidate.channel.successCount,
      failCount: candidate.channel.failCount,
      totalLatencyMs: candidate.channel.totalLatencyMs,
      lastFailAt: candidate.channel.lastFailAt,
      consecutiveFailCount: candidate.channel.consecutiveFailCount,
      cooldownLevel: candidate.channel.cooldownLevel,
    }, nowMs));

    const contributions = candidates.map((candidate, i) => {
      const siteChannels = Math.max(1, siteChannelCounts.get(candidate.site.id) || 1);
      let contribution = baseContributions[i] / siteChannels;
      const downstreamSiteMultiplier = downstreamPolicy.siteWeightMultipliers[candidate.site.id] ?? 1;
      const normalizedDownstreamSiteMultiplier =
        (Number.isFinite(downstreamSiteMultiplier) && downstreamSiteMultiplier > 0)
          ? downstreamSiteMultiplier
          : 1;
      const siteGlobalWeight =
        (Number.isFinite(candidate.site.globalWeight) && (candidate.site.globalWeight || 0) > 0)
          ? (candidate.site.globalWeight as number)
          : 1;
      const combinedSiteWeight = siteGlobalWeight * normalizedDownstreamSiteMultiplier;
      if (combinedSiteWeight > 0 && Number.isFinite(combinedSiteWeight)) {
        contribution *= combinedSiteWeight;
      }

      contribution *= runtimeHealthDetails[i]?.combinedMultiplier ?? 1;
      contribution *= modelCircuitStatuses[i]?.effectiveMultiplier ?? 1;
      contribution *= channelHealthScores[i]?.multiplier ?? 1;
      contribution *= siteHistoricalHealthMetrics.get(candidate.site.id)?.multiplier ?? 1;
      contribution *= getAccountSuccessMultiplier(accountStates[i]?.successEma ?? 0.5);
      contribution *= getAccountLatencyMultiplier(accountStates[i]?.latencyEmaMs ?? null);
      contribution *= getAccountStickyMultiplier(candidate, stickyPreference.stickyBinding, stickyPreference.stickyReason);

      const normalizedRuntimeModelName = normalizeModelAlias(resolvedModelNames[i]);
      if (normalizedRuntimeModelName && hasModelPreference.has(normalizedRuntimeModelName)) {
        contribution *= modelPreferredSiteIds.has(candidate.site.id) ? 1.3 : 0.72;
      }
      if (candidate.channel.sourceModelDerived) {
        contribution *= hasVerifiedModelCapability(candidate, resolvedModelNames[i], nowMs) ? 1 : 0.08;
      }

      // If upstream price is unknown and we are using fallback unit cost,
      // apply an explicit penalty so raising fallback cost meaningfully lowers probability.
      if (effectiveCosts[i]?.source === 'fallback') {
        contribution *= 1 / Math.max(1, effectiveCosts[i]?.unitCost || 1);
      }

      return contribution;
    });

    const totalContribution = contributions.reduce((a, b) => a + b, 0);
    const rankedIndices = candidates.map((_, index) => index)
      .sort((leftIndex, rightIndex) => {
        const contributionDiff = contributions[rightIndex] - contributions[leftIndex];
        if (Math.abs(contributionDiff) > 1e-9) {
          return contributionDiff > 0 ? 1 : -1;
        }
        return this.compareStableFirstCandidates(candidates[leftIndex], candidates[rightIndex]);
      });
    const rankByIndex = new Map<number, number>();
    rankedIndices.forEach((candidateIndex, rank) => {
      rankByIndex.set(candidateIndex, rank + 1);
    });
    const details = candidates.map((candidate, i) => {
      const probability = totalContribution > 0 ? contributions[i] / totalContribution : 0;
      const weight = candidate.channel.weight ?? 10;
      const cost = effectiveCosts[i];
      const costSourceText = cost?.source === 'observed'
        ? '实测'
        : (cost?.source === 'configured' ? '配置' : (cost?.source === 'catalog' ? '目录' : '默认'));
      const siteChannels = Math.max(1, siteChannelCounts.get(candidate.site.id) || 1);
      const downstreamSiteMultiplier = downstreamPolicy.siteWeightMultipliers[candidate.site.id] ?? 1;
      const normalizedDownstreamSiteMultiplier =
        (Number.isFinite(downstreamSiteMultiplier) && downstreamSiteMultiplier > 0)
          ? downstreamSiteMultiplier
          : 1;
      const siteGlobalWeight =
        (Number.isFinite(candidate.site.globalWeight) && (candidate.site.globalWeight || 0) > 0)
          ? (candidate.site.globalWeight as number)
          : 1;
      const combinedSiteWeight = siteGlobalWeight * normalizedDownstreamSiteMultiplier;
      const siteRuntimeDetail = runtimeHealthDetails[i];
      const modelCircuitStatus = modelCircuitStatuses[i];
      const accountState = accountStates[i];
      const channelHealth = channelHealthScores[i];
      const siteHistoricalHealth = siteHistoricalHealthMetrics.get(candidate.site.id);
      const siteHistoricalMultiplier = siteHistoricalHealth?.multiplier ?? 1;
      const historicalSuccessRateText = siteHistoricalHealth?.successRate == null
        ? '—'
        : `${(siteHistoricalHealth.successRate * 100).toFixed(1)}%`;
      const historicalLatencyText = siteHistoricalHealth?.avgLatencyMs == null
        ? '—'
        : `${siteHistoricalHealth.avgLatencyMs}ms`;
      const runtimeHealthText = siteRuntimeDetail.modelKey
        ? `${siteRuntimeDetail.combinedMultiplier.toFixed(2)}（站点=${siteRuntimeDetail.globalMultiplier.toFixed(2)}，模型=${siteRuntimeDetail.modelMultiplier.toFixed(2)}）`
        : `${siteRuntimeDetail.globalMultiplier.toFixed(2)}`;
      const modelCircuitText = describeModelCircuitStatus(modelCircuitStatus);
      const accountSuccessMultiplier = getAccountSuccessMultiplier(accountState?.successEma ?? 0.5);
      const accountLatencyMultiplier = getAccountLatencyMultiplier(accountState?.latencyEmaMs ?? null);
      const accountStickyMultiplier = getAccountStickyMultiplier(candidate, stickyPreference.stickyBinding, stickyPreference.stickyReason);
      const accountInflightCount = getAccountSelectionLeases(candidate.account.id, nowMs).length;
      const accountConcurrencyBudget = getAccountConcurrencyBudget(candidate, accountState);
      const stickyLabel = stickyPreference.stickyBinding?.accountId === candidate.account.id
        ? (stickyPreference.stickyReason === 'reused' ? '命中' : `已打破:${stickyPreference.stickyReason}`)
        : '否';
      const reasonPrefix = selectionMode === 'stable_first'
        ? `稳定优先（综合评分第 ${rankByIndex.get(i) ?? 1} / ${candidates.length}`
        : '按权重随机';
      return {
        candidate,
        probability,
        reason: selectionMode === 'stable_first'
          ? `${reasonPrefix}，W=${weight}，成本=${costSourceText}:${(cost?.unitCost || 1).toFixed(6)}，站点权重=${siteGlobalWeight.toFixed(2)}x下游倍率=${normalizedDownstreamSiteMultiplier.toFixed(2)}=${combinedSiteWeight.toFixed(2)}，运行时健康=${runtimeHealthText}，模型熔断=${modelCircuitText}，通道健康=${channelHealth.summary}，历史健康=${siteHistoricalMultiplier.toFixed(2)}（成功率=${historicalSuccessRateText}，均延迟=${historicalLatencyText}，样本=${siteHistoricalHealth?.totalCalls ?? 0}），账号EMA=${(accountState?.successEma ?? 0.5).toFixed(2)}x${accountSuccessMultiplier.toFixed(2)}，账号延迟=${accountState?.latencyEmaMs == null ? '—' : `${Math.round(accountState.latencyEmaMs)}ms`}x${accountLatencyMultiplier.toFixed(2)}，账号并发=${accountInflightCount}/${accountConcurrencyBudget}，粘性=${stickyLabel}x${accountStickyMultiplier.toFixed(2)}，同站点通道=${siteChannels}，评分占比≈${(probability * 100).toFixed(1)}%）`
          : `按权重随机（W=${weight}，成本=${costSourceText}:${(cost?.unitCost || 1).toFixed(6)}，站点权重=${siteGlobalWeight.toFixed(2)}x下游倍率=${normalizedDownstreamSiteMultiplier.toFixed(2)}=${combinedSiteWeight.toFixed(2)}，运行时健康=${runtimeHealthText}，模型熔断=${modelCircuitText}，通道健康=${channelHealth.summary}，历史健康=${siteHistoricalMultiplier.toFixed(2)}（成功率=${historicalSuccessRateText}，均延迟=${historicalLatencyText}，样本=${siteHistoricalHealth?.totalCalls ?? 0}），账号EMA=${(accountState?.successEma ?? 0.5).toFixed(2)}x${accountSuccessMultiplier.toFixed(2)}，账号延迟=${accountState?.latencyEmaMs == null ? '—' : `${Math.round(accountState.latencyEmaMs)}ms`}x${accountLatencyMultiplier.toFixed(2)}，账号并发=${accountInflightCount}/${accountConcurrencyBudget}，粘性=${stickyLabel}x${accountStickyMultiplier.toFixed(2)}，同站点通道=${siteChannels}，概率≈${(probability * 100).toFixed(1)}%）`,
      };
    });

    let selected = candidates[rankedIndices[0] ?? 0];
    if (selectionMode === 'weighted') {
      let rand = Math.random() * totalContribution;
      selected = candidates[candidates.length - 1];
      for (let i = 0; i < candidates.length; i++) {
        rand -= contributions[i];
        if (rand <= 0) {
          selected = candidates[i];
          break;
        }
      }
    }

    return { selected, details };
  }
}

export const tokenRouter = new TokenRouter();
