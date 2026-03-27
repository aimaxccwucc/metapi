import type { CheckinResolution } from './failureReasonService.js';

const CHECKIN_SITE_RUNTIME_SETTING_KEY = 'checkin_site_runtime_v1';
const CHECKIN_SITE_RUNTIME_PERSIST_DEBOUNCE_MS = 500;
const CHECKIN_SITE_RUNTIME_SYNC_INTERVAL_MS = 10_000;
const CHECKIN_SITE_RUNTIME_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHECKIN_SITE_RUNTIME_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

type CheckinSiteRuntimeState = {
  failureStreak: number;
  blockedUntilMs: number | null;
  lastFailureAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastReasonCode: string | null;
  lastMessage: string | null;
  updatedAtMs: number;
};

type CheckinSiteRuntimePersistencePayload = {
  version: 1;
  savedAtMs: number;
  bySiteId: Record<string, CheckinSiteRuntimeState>;
};

export type CheckinSiteRuntimeSnapshotEntry = {
  siteId: number;
  failureStreak: number;
  blockedUntilMs: number | null;
  blocked: boolean;
  lastFailureAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastReasonCode: string | null;
  lastMessage: string | null;
  updatedAtMs: number;
};

export type CheckinSiteBackoffDecision = {
  siteId: number;
  blocked: boolean;
  blockedUntilMs: number | null;
  blockedUntil: string | null;
  failureStreak: number;
  lastReasonCode: string | null;
  lastMessage: string | null;
};

const checkinSiteRuntimeStates = new Map<number, CheckinSiteRuntimeState>();
let checkinSiteRuntimeLoaded = false;
let checkinSiteRuntimeLoadPromise: Promise<void> | null = null;
let checkinSiteRuntimeSaveTimer: ReturnType<typeof setTimeout> | null = null;
let checkinSiteRuntimePersistInFlight: Promise<void> | null = null;
let checkinSiteRuntimeLastSyncedAtMs = 0;
let checkinSiteRuntimeContextTag: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readFiniteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readNullableTimestamp(value: unknown): number | null {
  const normalized = readFiniteInteger(value);
  if (normalized == null || normalized <= 0) return null;
  return normalized;
}

function getCurrentCheckinSiteRuntimeContextTag(): string | null {
  const dataDir = (process.env.DATA_DIR || '').trim();
  return dataDir || null;
}

function refreshCheckinSiteRuntimeContext(): void {
  const nextContextTag = getCurrentCheckinSiteRuntimeContextTag();
  if (nextContextTag === checkinSiteRuntimeContextTag) return;

  checkinSiteRuntimeStates.clear();
  checkinSiteRuntimeLoaded = false;
  checkinSiteRuntimeLoadPromise = null;
  if (checkinSiteRuntimeSaveTimer) {
    clearTimeout(checkinSiteRuntimeSaveTimer);
    checkinSiteRuntimeSaveTimer = null;
  }
  checkinSiteRuntimePersistInFlight = null;
  checkinSiteRuntimeLastSyncedAtMs = 0;
  checkinSiteRuntimeContextTag = nextContextTag;
}

function cloneCheckinSiteRuntimeState(state: CheckinSiteRuntimeState): CheckinSiteRuntimeState {
  return {
    failureStreak: state.failureStreak,
    blockedUntilMs: state.blockedUntilMs,
    lastFailureAtMs: state.lastFailureAtMs,
    lastSuccessAtMs: state.lastSuccessAtMs,
    lastReasonCode: state.lastReasonCode,
    lastMessage: state.lastMessage,
    updatedAtMs: state.updatedAtMs,
  };
}

function hydrateCheckinSiteRuntimeState(raw: unknown): CheckinSiteRuntimeState | null {
  if (!isRecord(raw)) return null;
  return {
    failureStreak: Math.max(0, readFiniteInteger(raw.failureStreak) ?? 0),
    blockedUntilMs: readNullableTimestamp(raw.blockedUntilMs),
    lastFailureAtMs: readNullableTimestamp(raw.lastFailureAtMs),
    lastSuccessAtMs: readNullableTimestamp(raw.lastSuccessAtMs),
    lastReasonCode: typeof raw.lastReasonCode === 'string' && raw.lastReasonCode.trim().length > 0
      ? raw.lastReasonCode.trim()
      : null,
    lastMessage: typeof raw.lastMessage === 'string' && raw.lastMessage.trim().length > 0
      ? raw.lastMessage.trim()
      : null,
    updatedAtMs: Math.max(0, readFiniteInteger(raw.updatedAtMs) ?? Date.now()),
  };
}

function resolveCheckinSiteBlockMs(
  category: CheckinResolution['category'],
  failureStreak: number,
): number {
  const normalizedStreak = Math.max(1, Math.min(6, Math.trunc(failureStreak) || 1));
  const levels = category === 'site'
    ? [30 * 60 * 1000, 2 * 60 * 60 * 1000, 8 * 60 * 60 * 1000]
    : (category === 'network'
      ? [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000]
      : [10 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000]);
  return levels[Math.min(levels.length - 1, normalizedStreak - 1)] ?? levels[levels.length - 1]!;
}

function shouldTrackCheckinSiteFailure(resolution: CheckinResolution): boolean {
  if (resolution.lifecycle !== 'failed') return false;
  if (resolution.category === 'auth') return false;
  if (resolution.requiresManual || resolution.unsupported) return false;
  return true;
}

function shouldPersistCheckinSiteRuntimeState(state: CheckinSiteRuntimeState, nowMs = Date.now()): boolean {
  const lastTouchedAtMs = Math.max(
    state.updatedAtMs,
    state.lastFailureAtMs ?? 0,
    state.lastSuccessAtMs ?? 0,
    state.blockedUntilMs ?? 0,
  );
  if ((nowMs - lastTouchedAtMs) > CHECKIN_SITE_RUNTIME_STALE_TTL_MS) return false;
  if (state.blockedUntilMs != null && state.blockedUntilMs > nowMs) return true;
  return (nowMs - lastTouchedAtMs) <= CHECKIN_SITE_RUNTIME_IDLE_TTL_MS;
}

function pruneCheckinSiteRuntimeStates(nowMs = Date.now()): void {
  for (const [siteId, state] of checkinSiteRuntimeStates.entries()) {
    if (!shouldPersistCheckinSiteRuntimeState(state, nowMs)) {
      checkinSiteRuntimeStates.delete(siteId);
    }
  }
}

function buildCheckinSiteRuntimePersistencePayload(nowMs = Date.now()): CheckinSiteRuntimePersistencePayload {
  const bySiteId: Record<string, CheckinSiteRuntimeState> = {};
  pruneCheckinSiteRuntimeStates(nowMs);
  for (const [siteId, state] of checkinSiteRuntimeStates.entries()) {
    if (!shouldPersistCheckinSiteRuntimeState(state, nowMs)) continue;
    bySiteId[String(siteId)] = cloneCheckinSiteRuntimeState(state);
  }
  return {
    version: 1,
    savedAtMs: nowMs,
    bySiteId,
  };
}

async function persistCheckinSiteRuntimeState(): Promise<void> {
  refreshCheckinSiteRuntimeContext();
  if (checkinSiteRuntimePersistInFlight) {
    await checkinSiteRuntimePersistInFlight;
    return;
  }
  const persistTask = (async () => {
    const nowMs = Date.now();
    try {
      const [{ upsertSetting }] = await Promise.all([
        import('../db/upsertSetting.js'),
      ]);
      await upsertSetting(CHECKIN_SITE_RUNTIME_SETTING_KEY, buildCheckinSiteRuntimePersistencePayload(nowMs));
      checkinSiteRuntimeLastSyncedAtMs = nowMs;
    } catch {
      // Allow runtime memory fallback under partial mocks or transient db failures.
    }
  })();
  checkinSiteRuntimePersistInFlight = persistTask.finally(() => {
    if (checkinSiteRuntimePersistInFlight === persistTask) {
      checkinSiteRuntimePersistInFlight = null;
    }
  });
  await checkinSiteRuntimePersistInFlight;
}

function scheduleCheckinSiteRuntimePersistence(): void {
  if (checkinSiteRuntimeSaveTimer) return;
  checkinSiteRuntimeSaveTimer = setTimeout(() => {
    checkinSiteRuntimeSaveTimer = null;
    void persistCheckinSiteRuntimeState();
  }, CHECKIN_SITE_RUNTIME_PERSIST_DEBOUNCE_MS);
}

async function loadCheckinSiteRuntimeStateFromSettings(force = false): Promise<void> {
  refreshCheckinSiteRuntimeContext();
  const nowMs = Date.now();
  if (!force && checkinSiteRuntimeLoaded && (nowMs - checkinSiteRuntimeLastSyncedAtMs) < CHECKIN_SITE_RUNTIME_SYNC_INTERVAL_MS) {
    return;
  }

  try {
    const [{ eq }, { db, schema }] = await Promise.all([
      import('drizzle-orm'),
      import('../db/index.js'),
    ]);
    if (!db || typeof (db as any).select !== 'function' || !schema?.settings) {
      return;
    }

    const row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, CHECKIN_SITE_RUNTIME_SETTING_KEY))
      .get();

    let parsed: unknown;
    try {
      parsed = row?.value ? JSON.parse(row.value) : null;
    } catch {
      parsed = null;
    }
    if (isRecord(parsed) && isRecord(parsed.bySiteId)) {
      for (const [siteIdKey, stateRaw] of Object.entries(parsed.bySiteId)) {
        const siteId = Number(siteIdKey);
        if (!Number.isFinite(siteId) || siteId <= 0) continue;
        const state = hydrateCheckinSiteRuntimeState(stateRaw);
        if (!state) continue;
        const existing = checkinSiteRuntimeStates.get(siteId);
        if (!existing || state.updatedAtMs >= existing.updatedAtMs) {
          checkinSiteRuntimeStates.set(siteId, state);
        }
      }
    }
  } catch {
    // Allow runtime memory fallback when db access is unavailable.
  }

  pruneCheckinSiteRuntimeStates(nowMs);
  checkinSiteRuntimeLoaded = true;
  checkinSiteRuntimeLastSyncedAtMs = nowMs;
}

async function ensureCheckinSiteRuntimeStateLoaded(): Promise<void> {
  refreshCheckinSiteRuntimeContext();
  if (checkinSiteRuntimeLoaded && (Date.now() - checkinSiteRuntimeLastSyncedAtMs) < CHECKIN_SITE_RUNTIME_SYNC_INTERVAL_MS) return;
  if (!checkinSiteRuntimeLoadPromise) {
    checkinSiteRuntimeLoadPromise = (async () => {
      try {
        await loadCheckinSiteRuntimeStateFromSettings(!checkinSiteRuntimeLoaded);
      } finally {
        checkinSiteRuntimeLoadPromise = null;
      }
    })();
  }
  await checkinSiteRuntimeLoadPromise;
}

function getOrCreateCheckinSiteRuntimeState(siteId: number, nowMs = Date.now()): CheckinSiteRuntimeState {
  const existing = checkinSiteRuntimeStates.get(siteId);
  if (existing) {
    existing.updatedAtMs = Math.max(existing.updatedAtMs, nowMs);
    return existing;
  }
  const state: CheckinSiteRuntimeState = {
    failureStreak: 0,
    blockedUntilMs: null,
    lastFailureAtMs: null,
    lastSuccessAtMs: null,
    lastReasonCode: null,
    lastMessage: null,
    updatedAtMs: nowMs,
  };
  checkinSiteRuntimeStates.set(siteId, state);
  return state;
}

export async function recordCheckinSiteResolution(
  siteId: number,
  resolution: CheckinResolution,
  nowMs = Date.now(),
): Promise<void> {
  if (!Number.isFinite(siteId) || siteId <= 0) return;
  await ensureCheckinSiteRuntimeStateLoaded();

  if (!shouldTrackCheckinSiteFailure(resolution)) {
    const existing = checkinSiteRuntimeStates.get(siteId);
    if (!existing) return;
    existing.failureStreak = 0;
    existing.blockedUntilMs = null;
    existing.lastSuccessAtMs = nowMs;
    existing.updatedAtMs = nowMs;
    existing.lastReasonCode = null;
    existing.lastMessage = null;
    scheduleCheckinSiteRuntimePersistence();
    return;
  }

  const state = getOrCreateCheckinSiteRuntimeState(siteId, nowMs);
  state.failureStreak = Math.min(8, state.failureStreak + 1);
  state.blockedUntilMs = nowMs + resolveCheckinSiteBlockMs(resolution.category, state.failureStreak);
  state.lastFailureAtMs = nowMs;
  state.lastReasonCode = resolution.code;
  state.lastMessage = resolution.logMessage || null;
  state.updatedAtMs = nowMs;
  scheduleCheckinSiteRuntimePersistence();
}

export async function getCheckinSiteBackoffDecision(
  siteId: number,
  nowMs = Date.now(),
): Promise<CheckinSiteBackoffDecision> {
  await ensureCheckinSiteRuntimeStateLoaded();
  pruneCheckinSiteRuntimeStates(nowMs);
  const state = checkinSiteRuntimeStates.get(siteId) ?? null;
  const blocked = !!(state?.blockedUntilMs && state.blockedUntilMs > nowMs);
  return {
    siteId,
    blocked,
    blockedUntilMs: blocked ? state?.blockedUntilMs ?? null : null,
    blockedUntil: blocked && state?.blockedUntilMs ? new Date(state.blockedUntilMs).toISOString() : null,
    failureStreak: state?.failureStreak ?? 0,
    lastReasonCode: state?.lastReasonCode ?? null,
    lastMessage: state?.lastMessage ?? null,
  };
}

export async function listCheckinSiteRuntimeSnapshots(nowMs = Date.now()): Promise<CheckinSiteRuntimeSnapshotEntry[]> {
  await ensureCheckinSiteRuntimeStateLoaded();
  pruneCheckinSiteRuntimeStates(nowMs);
  return Array.from(checkinSiteRuntimeStates.entries())
    .map(([siteId, state]) => ({
      siteId,
      failureStreak: state.failureStreak,
      blockedUntilMs: state.blockedUntilMs,
      blocked: !!(state.blockedUntilMs && state.blockedUntilMs > nowMs),
      lastFailureAtMs: state.lastFailureAtMs,
      lastSuccessAtMs: state.lastSuccessAtMs,
      lastReasonCode: state.lastReasonCode,
      lastMessage: state.lastMessage,
      updatedAtMs: state.updatedAtMs,
    }))
    .sort((left, right) => (
      Number(right.blocked) - Number(left.blocked)
      || right.failureStreak - left.failureStreak
      || left.siteId - right.siteId
    ));
}

export async function flushCheckinSiteRuntimePersistence(): Promise<void> {
  if (checkinSiteRuntimeSaveTimer) {
    clearTimeout(checkinSiteRuntimeSaveTimer);
    checkinSiteRuntimeSaveTimer = null;
    await persistCheckinSiteRuntimeState();
    return;
  }
  if (checkinSiteRuntimePersistInFlight) {
    await checkinSiteRuntimePersistInFlight;
  }
}

export function resetCheckinSiteRuntimeState(): void {
  checkinSiteRuntimeStates.clear();
  checkinSiteRuntimeLoaded = false;
  checkinSiteRuntimeLoadPromise = null;
  if (checkinSiteRuntimeSaveTimer) {
    clearTimeout(checkinSiteRuntimeSaveTimer);
    checkinSiteRuntimeSaveTimer = null;
  }
  checkinSiteRuntimePersistInFlight = null;
  checkinSiteRuntimeLastSyncedAtMs = 0;
  checkinSiteRuntimeContextTag = null;
}
