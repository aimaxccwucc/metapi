import { and, eq, inArray } from 'drizzle-orm';
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
} from './modelCircuitBreaker.js';
import { classifyProxyFailureCategory } from './proxyRetryPolicy.js';

interface RouteMatch {
  route: RouteRow;
  channels: Array<{
    channel: typeof schema.routeChannels.$inferSelect;
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
const PERSISTED_MODEL_UNAVAILABLE_TTL_MS = 6 * 60 * 60 * 1000;
const CHANNEL_SELECTION_LEASE_DEFAULT_MS = 30_000;
const CHANNEL_SELECTION_LEASE_MIN_MS = 15_000;
const CHANNEL_SELECTION_LEASE_MAX_MS = 90_000;

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

const siteRuntimeHealthStates = new Map<number, SiteRuntimeHealthState>();
const siteModelRuntimeHealthStates = new Map<number, Map<string, SiteRuntimeHealthState>>();
const channelSelectionLeases = new Map<number, ChannelSelectionLease>();
let siteRuntimeHealthLoaded = false;
let siteRuntimeHealthLoadPromise: Promise<void> | null = null;
let siteRuntimeHealthSaveTimer: ReturnType<typeof setTimeout> | null = null;
let siteRuntimeHealthPersistInFlight: Promise<void> | null = null;

function createEmptyPersistedUnavailableModelSnapshot(): PersistedUnavailableModelSnapshot {
  return {
    tokenModels: new Map<number, Map<string, number>>(),
    accountModels: new Map<number, Map<string, number>>(),
  };
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

function resolveSiteRuntimeFailurePenalty(context: SiteRuntimeFailureContext = {}): number {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();

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

function isAuthLikeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
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
    || category === 'rate_limit';
}

function shouldApplySiteWideFailureTracking(context: SiteRuntimeFailureContext = {}): boolean {
  const category = classifyProxyFailureCategory(context.status, context.errorText);
  return category === 'network' || category === 'server' || category === 'rate_limit';
}

function shouldApplySiteModelFailureTracking(context: SiteRuntimeFailureContext = {}): boolean {
  const category = classifyProxyFailureCategory(context.status, context.errorText);
  return category === 'network' || category === 'server' || category === 'rate_limit';
}

function isTransientSiteRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  return status >= 500 || status === 429 || matchesAnyPattern(SITE_TRANSIENT_FAILURE_PATTERNS, errorText);
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

function applyRuntimeHealthFailure(state: SiteRuntimeHealthState, context: SiteRuntimeFailureContext = {}, nowMs = Date.now()): void {
  state.penaltyScore += resolveSiteRuntimeFailurePenalty(context);
  const immediateBreakerMs = resolveImmediateModelBreakerDurationMs(context);
  if (immediateBreakerMs > 0 && shouldOpenSiteWideRuntimeBreaker(context)) {
    state.breakerLevel = Math.min(
      SITE_RUNTIME_BREAKER_LEVELS_MS.length - 1,
      state.breakerLevel + 1,
    );
    state.breakerUntilMs = nowMs + immediateBreakerMs;
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
      state.breakerUntilMs = breakerMs > 0 ? nowMs + breakerMs : null;
      state.transientFailureStreak = 0;
    }
  } else {
    state.transientFailureStreak = 0;
    state.lastTransientFailureAtMs = null;
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

function shouldOpenSiteWideRuntimeBreaker(context: SiteRuntimeFailureContext = {}): boolean {
  const category = classifyProxyFailureCategory(context.status, context.errorText);
  return category === 'network' || category === 'server' || category === 'rate_limit';
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
  siteRuntimeHealthLoaded = false;
  siteRuntimeHealthLoadPromise = null;
  if (siteRuntimeHealthSaveTimer) {
    clearTimeout(siteRuntimeHealthSaveTimer);
    siteRuntimeHealthSaveTimer = null;
  }
  siteRuntimeHealthPersistInFlight = null;
}

export async function flushSiteRuntimeHealthPersistence(): Promise<void> {
  if (siteRuntimeHealthSaveTimer) {
    clearTimeout(siteRuntimeHealthSaveTimer);
    siteRuntimeHealthSaveTimer = null;
    await persistSiteRuntimeHealthState();
    return;
  }
  if (siteRuntimeHealthPersistInFlight) {
    await siteRuntimeHealthPersistInFlight;
  }
}

export async function clearRoutingRuntimeState(): Promise<{
  updatedChannels: number;
  clearedModelCircuits: number;
  clearedPersistedSiteRuntimeState: boolean;
}> {
  await ensureSiteRuntimeHealthStateLoaded();

  const updatedChannels = (await db.update(schema.routeChannels).set({
    lastFailAt: null,
    consecutiveFailCount: 0,
    cooldownLevel: 0,
    cooldownUntil: null,
  }).run()).changes;

  const clearedPersistedSiteRuntimeState = (await db.delete(schema.settings)
    .where(eq(schema.settings.key, SITE_RUNTIME_HEALTH_SETTING_KEY))
    .run()).changes > 0;

  resetSiteRuntimeHealthState();
  const clearedModelCircuits = resetAllModelCircuits();
  invalidateTokenRouterCache();

  return {
    updatedChannels,
    clearedModelCircuits,
    clearedPersistedSiteRuntimeState,
  };
}

export async function listSiteRuntimeHealthSnapshots(nowMs = Date.now()): Promise<SiteRuntimeHealthSnapshotEntry[]> {
  await ensureSiteRuntimeHealthStateLoaded();
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
    .filter((route) => normalizeRouteMode(route.routeMode) === 'explicit_group')
    .map((route) => route.id);
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
  const routes = rawRoutes.map((route) => ({
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
    return Array.from(new Set(route.sourceRouteIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0)));
  })();
  const enabledSourceRoutes = isExplicitGroupRoute(route)
    ? enabledRoutes.filter((item) => (
      routeIds.includes(item.id)
      && !isExplicitGroupRoute(item)
      && isExactRouteModelPattern(item.modelPattern)
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

  const mapped = channels.map((row) => ({
    channel: {
      ...row.route_channels,
      sourceModel: normalizeChannelSourceModel(row.route_channels.sourceModel)
        || fallbackSourceModelByRouteId.get(row.route_channels.routeId)
        || null,
    },
    account: row.accounts,
    site: row.sites,
    token: row.account_tokens,
  }));

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
  recentlyFailed: boolean;
  avoidedByRecentFailure: boolean;
  avoidedByInflightLease?: boolean;
  cooldownUntil?: string | null;
  lastFailAt?: string | null;
  leasedUntil?: string | null;
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
  nowIso?: string;
  nowMs?: number;
  runtimeModelName?: string | null;
  persistedUnavailableModels?: PersistedUnavailableModelSnapshot;
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
      return normalizeRouteDisplayName(route.displayName).length > 0
        && route.sourceRouteIds.length > 0;
    }
    return hasCustomDisplayName(route);
  });
}

function buildVisibleEnabledRoutesForPolicy(
  routes: RouteRow[],
  downstreamPolicy: DownstreamRoutingPolicy,
): RouteRow[] {
  const visibleRoutes = buildVisibleEnabledRoutes(routes);
  const supportedPatterns = Array.isArray(downstreamPolicy.supportedModels)
    ? downstreamPolicy.supportedModels
    : [];
  const allowedRouteIdSet = new Set(
    Array.isArray(downstreamPolicy.allowedRouteIds)
      ? downstreamPolicy.allowedRouteIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0)
      : [],
  );

  if (supportedPatterns.length === 0 && allowedRouteIdSet.size === 0) {
    return visibleRoutes;
  }

  return visibleRoutes.filter((route) => {
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

export class TokenRouter {
  /**
   * Find matching route and select a channel for the given model.
   * Returns null if no route/channel available.
   */
  async selectChannel(requestedModel: string, downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();

    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, requestedModel, downstreamPolicy);
  }

  async previewSelectedChannel(
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();

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
  ): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();

    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, requestedModel, downstreamPolicy, excludeChannelIds);
  }

  async explainSelection(
    requestedModel: string,
    excludeChannelIds: number[] = [],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<RouteDecisionExplanation> {
    await ensureSiteRuntimeHealthStateLoaded();
    const match = await this.findRoute(requestedModel, downstreamPolicy);
    return await this.explainSelectionFromMatch(match, requestedModel, { excludeChannelIds, downstreamPolicy });
  }

  async explainSelectionForRoute(
    routeId: number,
    requestedModel: string,
    excludeChannelIds: number[] = [],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<RouteDecisionExplanation> {
    await ensureSiteRuntimeHealthStateLoaded();
    const match = await this.findRouteById(routeId, downstreamPolicy);
    return await this.explainSelectionFromMatch(match, requestedModel, { excludeChannelIds, downstreamPolicy });
  }

  async explainSelectionRouteWide(routeId: number, downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY): Promise<RouteDecisionExplanation> {
    await ensureSiteRuntimeHealthStateLoaded();
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

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
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
      const reasonParts = this.getCandidateEligibilityReasons(row, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        nowIso,
        nowMs,
        runtimeModelName,
        persistedUnavailableModels,
      });
      const modelCircuitStatus = getCandidateModelCircuitStatus(row.channel.id, runtimeModelName, nowMs);
      const runtimeHealthDetails = getSiteRuntimeHealthDetails(row.site.id, runtimeModelName, nowMs);
      const runtimeCircuit = buildRuntimeCircuitStatus(runtimeHealthDetails);

      const recentlyFailed = routeStrategy !== 'round_robin'
        ? isChannelRecentlyFailed(row.channel, nowMs)
        : false;
      const eligible = reasonParts.length === 0;
      let reason = eligible ? '可用' : reasonParts.join('、');
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
        recentlyFailed,
        avoidedByRecentFailure: false,
        avoidedByInflightLease: false,
        cooldownUntil: row.channel.cooldownUntil ?? null,
        lastFailAt: row.channel.lastFailAt ?? null,
        leasedUntil: getChannelSelectionLeaseUntil(row.channel.id, nowMs),
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
    const minAvailablePriority = availableByPriority.size > 0
      ? Math.min(...Array.from(availableByPriority.keys()))
      : null;
    const hasHigherPriorityModelCircuitBlock = minAvailablePriority != null
      && candidates.some((candidate) => (
        !candidate.eligible
        && candidate.priority < minAvailablePriority
        && candidate.reason.includes('模型熔断中')
      ));

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
      const recoveryCandidates = recentFailurePartition.preferred.length > 0
        ? recentFailurePartition.preferred
        : sortCandidatesForRecoveryPreference(recentFailurePartition.avoided);
      if (recentFailurePartition.preferred.length === 0 && recentFailurePartition.avoided.length > 0) {
        summary.push('全部候选近期失败，已切换为保守恢复探测');
      }

      const leasePartition = partitionChannelSelectionLeases(
        recoveryCandidates,
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
          : recoveryCandidates,
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
    let recoverySelected = false;
    let sawFullyBlockedByRuntimeBreaker = false;
    const degradedRecoveryPool: RouteChannelCandidate[] = [];

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
        sawFullyBlockedByRuntimeBreaker = true;
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
        degradedRecoveryPool.push(...recentFailurePartition.avoided);
        continue;
      }

      const leasePartition = partitionChannelSelectionLeases(recentFailurePartition.preferred, nowMs);
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
        : recentFailurePartition.preferred;

      const weighted = this.calculateWeightedSelection(
        candidateLayer,
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
      if (degradedAcrossPriorityByRecentFailure) {
        layerSummaryParts.push('上层最近失败，已自动降级');
      }
      if (recentFailurePartition.preferred.length === 0 && recentFailurePartition.avoided.length > 0) {
        layerSummaryParts.push('当前层全部近期失败，已切换保守恢复探测');
      }
      summary.push(layerSummaryParts.join('，'));
      break;
    }

    if (!selected && !sawFullyBlockedByRuntimeBreaker && !hasHigherPriorityModelCircuitBlock && degradedRecoveryPool.length > 0) {
      const recoveryCandidates = sortCandidatesForRecoveryPreference(
        Array.from(new Map(
          degradedRecoveryPool.map((candidate) => [candidate.channel.id, candidate]),
        ).values()),
      );
      const leasePartition = partitionChannelSelectionLeases(recoveryCandidates, nowMs);
      if (leasePartition.preferred.length > 0 && leasePartition.avoided.length > 0) {
        for (const item of leasePartition.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.avoidedByInflightLease = true;
          target.reason = `通道忙碌中，优先避让（${resolveLeaseAvoidWindowSec(item.leaseUntil, nowMs)} 秒租约）`;
        }
      }
      const recoveryLayer = leasePartition.preferred.length > 0
        ? leasePartition.preferred
        : recoveryCandidates;
      const recoveryCandidate = recoveryLayer[0] ?? null;
      if (recoveryCandidate) {
        selected = recoveryCandidate;
        selectedPriority = recoveryCandidate.channel.priority ?? 0;
        recoverySelected = true;
        for (const candidate of recoveryLayer) {
          const target = candidateMap.get(candidate.channel.id);
          if (!target) continue;
          target.probability = candidate.channel.id === recoveryCandidate.channel.id ? 100 : 0;
          target.reason = candidate.channel.id === recoveryCandidate.channel.id
            ? '保守恢复探测（全部优先级近期失败，优先尝试最久未失败通道）'
            : '保守恢复探测待命';
        }
        const recoverySummaryParts = [
          `优先级 P${selectedPriority}：当前层全部近期失败，已切换保守恢复探测`,
        ];
        if (degradedAcrossPriorityByRecentFailure) {
          recoverySummaryParts.push('上层最近失败，已自动降级');
        }
        summary.push(recoverySummaryParts.join('，'));
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
    summary.push(
      recoverySelected
        ? `最终选择：${selectedLabel}（P${selectedPriority}，保守恢复探测）`
        : `最终选择：${selectedLabel}（P${selectedPriority}）`,
    );
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
    await ensureSiteRuntimeHealthStateLoaded();
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

    await restorePersistedModelAvailabilityForChannel(ch, account.id, modelName);

    if (normalizeModelAlias(modelName || '')) {
      recordModelCircuitSuccess(channelId, modelName || '', nowMs);
    }
    recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName, nowMs);
  }

  /**
   * Record failure and set cooldown.
   */
  async recordFailure(channelId: number, context: SiteRuntimeFailureContext | string | null = {}) {
    await ensureSiteRuntimeHealthStateLoaded();
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
    const failCount = (ch.failCount ?? 0) + 1;
    const normalizedContext: SiteRuntimeFailureContext = typeof context === 'string'
      ? { modelName: context }
      : (context ?? {});
    const routeStrategy = resolveRouteStrategy(route);
    let cooldownUntil: string | null = null;
    let consecutiveFailCount = Math.max(0, ch.consecutiveFailCount ?? 0) + 1;
    let cooldownLevel = Math.max(0, ch.cooldownLevel ?? 0);
    const failureCategory = classifyProxyFailureCategory(normalizedContext.status, normalizedContext.errorText);

    if (routeStrategy === 'round_robin') {
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

    await db.update(schema.routeChannels).set({
      failCount,
      lastFailAt: nowIso,
      consecutiveFailCount,
      cooldownLevel,
      cooldownUntil,
    }).where(eq(schema.routeChannels.id, channelId)).run();

    patchCachedChannel(channelId, (channel) => {
      channel.failCount = failCount;
      channel.lastFailAt = nowIso;
      channel.cooldownUntil = cooldownUntil;
      channel.consecutiveFailCount = consecutiveFailCount;
      channel.cooldownLevel = cooldownLevel;
    });
    releaseChannelSelectionLease(channelId);

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
          recordModelCircuitFailure(
            channelId,
            normalizedRuntimeModelName,
            failureCategory === 'other' ? 'unknown' : failureCategory,
            nowMs,
          );
        }
      }
    }
    recordSiteRuntimeFailure(account.siteId, normalizedContext, nowMs);
  }

  /**
   * Get all available models (aggregated from all routes).
   */
  async getAvailableModels(downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY): Promise<string[]> {
    const routes = await loadEnabledRoutes();
    const exposed = buildVisibleEnabledRoutesForPolicy(routes, downstreamPolicy)
      .map((route) => getExposedModelNameForRoute(route).trim())
      .filter((name) => name.length > 0);
    return Array.from(new Set(exposed));
  }

  // --- Private methods ---

  private async selectFromMatch(
    match: RouteMatch,
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy,
    excludeChannelIds: number[] = [],
    recordSelection = true,
  ): Promise<SelectedChannel | null> {
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const bypassSourceModelCheck = requestedByDisplayName;
    const routeStrategy = resolveRouteStrategy(match.route);
    const runtimeModelResolver = requestedByDisplayName
      ? ((candidate: RouteChannelCandidate) => normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
      : mappedModel;
    const persistedUnavailableModels = await loadPersistedUnavailableModelsForCandidates(match.channels);

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const evaluatedCandidates = match.channels.map((candidate) => {
      const runtimeModelName = typeof runtimeModelResolver === 'function'
        ? runtimeModelResolver(candidate)
        : runtimeModelResolver;
      const reasons = this.getCandidateEligibilityReasons(candidate, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        nowIso,
        nowMs,
        runtimeModelName,
        persistedUnavailableModels,
      });
      return {
        candidate,
        reasons,
      };
    });
    const available = evaluatedCandidates
      .filter((entry) => entry.reasons.length === 0)
      .map((entry) => entry.candidate);
    const minAvailablePriority = available.length > 0
      ? Math.min(...available.map((candidate) => candidate.channel.priority ?? 0))
      : null;
    const hasHigherPriorityModelCircuitBlock = minAvailablePriority != null
      && evaluatedCandidates.some((entry) => (
        (entry.candidate.channel.priority ?? 0) < minAvailablePriority
        && entry.reasons.includes('模型熔断中')
      ));

    if (available.length === 0) return null;

    if (routeStrategy === 'round_robin') {
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(available, runtimeModelResolver, nowMs);
      const fullyBlockedByRuntimeBreaker =
        breakerFiltered.avoided.length > 0 && breakerFiltered.candidates.length === available.length;
      if (fullyBlockedByRuntimeBreaker) return null;
      const recentFailurePartition = partitionRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      const recoveryCandidates = recentFailurePartition.preferred.length > 0
        ? recentFailurePartition.preferred
        : sortCandidatesForRecoveryPreference(recentFailurePartition.avoided);
      const leasePartition = partitionChannelSelectionLeases(
        recoveryCandidates,
        nowMs,
      );
      const selected = this.selectWithModelCircuitGuard(
        leasePartition.preferred.length > 0
          ? leasePartition.preferred
          : recoveryCandidates,
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
        reserveChannelSelectionLease(selected.channel.id, nowMs, resolveChannelSelectionLeaseMs(selected));
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
    let sawFullyBlockedByRuntimeBreaker = false;
    const degradedRecoveryPool: RouteChannelCandidate[] = [];
    for (const priority of sortedPriorities) {
      const rawLayer = layers.get(priority) ?? [];
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawLayer, runtimeModelResolver, nowMs);
      const fullyBlockedByRuntimeBreaker =
        breakerFiltered.avoided.length > 0 && breakerFiltered.candidates.length === rawLayer.length;
      if (fullyBlockedByRuntimeBreaker) {
        sawFullyBlockedByRuntimeBreaker = true;
        continue;
      }
      const recentFailurePartition = partitionRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      if (recentFailurePartition.preferred.length === 0 && recentFailurePartition.avoided.length > 0) {
        degradedRecoveryPool.push(...recentFailurePartition.avoided);
        continue;
      }
      const leasePartition = partitionChannelSelectionLeases(recentFailurePartition.preferred, nowMs);
      const candidateLayer = leasePartition.preferred.length > 0
        ? leasePartition.preferred
        : recentFailurePartition.preferred;
      const selected = routeStrategy === 'stable_first'
        ? this.selectWithModelCircuitGuard(
          candidateLayer,
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
          candidateLayer,
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
        reserveChannelSelectionLease(selected.channel.id, nowMs, resolveChannelSelectionLeaseMs(selected));
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

    if (!sawFullyBlockedByRuntimeBreaker && !hasHigherPriorityModelCircuitBlock && degradedRecoveryPool.length > 0) {
      const recoveryCandidates = sortCandidatesForRecoveryPreference(
        Array.from(new Map(
          degradedRecoveryPool.map((candidate) => [candidate.channel.id, candidate]),
        ).values()),
      );
      const leasePartition = partitionChannelSelectionLeases(recoveryCandidates, nowMs);
      const recoveryLayer = leasePartition.preferred.length > 0
        ? leasePartition.preferred
        : recoveryCandidates;
      const selected = recoveryLayer[0] ?? null;
      if (!selected) return null;

      const tokenValue = this.resolveChannelTokenValue(selected);
      if (!tokenValue) return null;
      if (routeStrategy === 'stable_first' && recordSelection) {
        await this.recordChannelSelection(selected.channel.id);
      }
      if (recordSelection) {
        reserveChannelSelectionLease(selected.channel.id, nowMs, resolveChannelSelectionLeaseMs(selected));
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

    const supportedPatterns = Array.isArray(downstreamPolicy.supportedModels)
      ? downstreamPolicy.supportedModels
      : [];
    const matchedSupportedPattern = supportedPatterns.some((pattern) => matchesModelPattern(model, pattern));

    if (downstreamPolicy.allowedRouteIds.length > 0 && !matchedSupportedPattern) {
      const allowSet = new Set(downstreamPolicy.allowedRouteIds);
      routes = routes.filter((route) => allowSet.has(route.id));
    }

    const matchedRoute = routes.find((route) => (
      !isExplicitGroupRoute(route)
      && isExactRouteModelPattern(route.modelPattern)
      && (route.modelPattern || '').trim() === model
    ))
      || routes.find((route) => isExplicitGroupRoute(route) && isRouteDisplayNameMatch(model, route.displayName))
      || routes.find((route) => !isExplicitGroupRoute(route) && isRouteDisplayNameMatch(model, route.displayName))
      || routes.find((route) => !isExplicitGroupRoute(route) && matchesModelPattern(model, route.modelPattern));

    if (!matchedRoute) return null;

    return await this.loadRouteMatch(matchedRoute);
  }

  private async findRouteById(routeId: number, downstreamPolicy: DownstreamRoutingPolicy): Promise<RouteMatch | null> {
    if (downstreamPolicy.allowedRouteIds.length > 0 && !downstreamPolicy.allowedRouteIds.includes(routeId)) {
      return null;
    }

    const route = (await loadEnabledRoutes()).find((item) => item.id === routeId);
    if (!route) return null;

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

    if (!candidate.channel.enabled) reasonParts.push('通道禁用');

    if (isExplicitTokenChannel(candidate)) {
      if (candidate.account.status === 'disabled') {
        reasonParts.push(`账号状态=${candidate.account.status}`);
      }
    } else if (candidate.account.status !== 'active') {
      reasonParts.push(`账号状态=${candidate.account.status}`);
    }

    if (isSiteDisabled(candidate.site.status)) {
      reasonParts.push(`站点状态=${candidate.site.status || 'disabled'}`);
    }

    if (excludeChannelIds.includes(candidate.channel.id)) {
      reasonParts.push('当前请求已尝试');
    }

    const tokenValue = this.resolveChannelTokenValue(candidate);
    if (!tokenValue) reasonParts.push('令牌不可用');

    if (candidate.channel.cooldownUntil && candidate.channel.cooldownUntil > nowIso) {
      reasonParts.push('冷却中');
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
    const effectiveCosts = candidates.map((candidate) => resolveEffectiveUnitCost(candidate, resolveModelName(candidate)));
    const runtimeHealthDetails = candidates.map((candidate) => (
      getSiteRuntimeHealthDetails(candidate.site.id, resolveModelName(candidate), nowMs)
    ));
    const modelCircuitStatuses = candidates.map((candidate) => (
      getCandidateModelCircuitStatus(candidate.channel.id, resolveModelName(candidate), nowMs)
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
      const reasonPrefix = selectionMode === 'stable_first'
        ? `稳定优先（综合评分第 ${rankByIndex.get(i) ?? 1} / ${candidates.length}`
        : '按权重随机';
      return {
        candidate,
        probability,
        reason: selectionMode === 'stable_first'
          ? `${reasonPrefix}，W=${weight}，成本=${costSourceText}:${(cost?.unitCost || 1).toFixed(6)}，站点权重=${siteGlobalWeight.toFixed(2)}x下游倍率=${normalizedDownstreamSiteMultiplier.toFixed(2)}=${combinedSiteWeight.toFixed(2)}，运行时健康=${runtimeHealthText}，模型熔断=${modelCircuitText}，通道健康=${channelHealth.summary}，历史健康=${siteHistoricalMultiplier.toFixed(2)}（成功率=${historicalSuccessRateText}，均延迟=${historicalLatencyText}，样本=${siteHistoricalHealth?.totalCalls ?? 0}），同站点通道=${siteChannels}，评分占比≈${(probability * 100).toFixed(1)}%）`
          : `按权重随机（W=${weight}，成本=${costSourceText}:${(cost?.unitCost || 1).toFixed(6)}，站点权重=${siteGlobalWeight.toFixed(2)}x下游倍率=${normalizedDownstreamSiteMultiplier.toFixed(2)}=${combinedSiteWeight.toFixed(2)}，运行时健康=${runtimeHealthText}，模型熔断=${modelCircuitText}，通道健康=${channelHealth.summary}，历史健康=${siteHistoricalMultiplier.toFixed(2)}（成功率=${historicalSuccessRateText}，均延迟=${historicalLatencyText}，样本=${siteHistoricalHealth?.totalCalls ?? 0}），同站点通道=${siteChannels}，概率≈${(probability * 100).toFixed(1)}%）`,
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

