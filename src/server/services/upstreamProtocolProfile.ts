import { eq } from 'drizzle-orm';

type UpstreamEndpoint = 'chat' | 'messages' | 'responses';

type EndpointProfileState = {
  preferredEndpoint: UpstreamEndpoint | null;
  preferredUpdatedAtMs: number;
  preferredReason: 'success' | 'suggested' | null;
  blockedUntilMsByEndpoint: Partial<Record<UpstreamEndpoint, number>>;
  probeAfterMs: number | null;
  lastProbeAtMs: number | null;
  lastProbeStatus: 'success' | 'failed' | null;
};

export type PersistedUpstreamProtocolProfileEntry = {
  key: string;
  preferredEndpoint: UpstreamEndpoint | null;
  preferredUpdatedAtMs: number;
  preferredReason: 'success' | 'suggested' | null;
  blockedUntilMsByEndpoint: Partial<Record<UpstreamEndpoint, number>>;
  activeBlocks: UpstreamEndpoint[];
  hasFreshPreference: boolean;
  probeAfterMs: number | null;
  probeReady: boolean;
  lastProbeAtMs: number | null;
  lastProbeStatus: 'success' | 'failed' | null;
};

type EndpointProfilePersistencePayload = {
  version: 1;
  savedAtMs: number;
  entries: Record<string, EndpointProfileState>;
};

const UPSTREAM_PROTOCOL_PROFILE_SETTING_KEY = 'upstream_protocol_profile_v1';
const PREFERRED_ENDPOINT_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_PERSIST_DEBOUNCE_MS = 500;

const endpointProfiles = new Map<string, EndpointProfileState>();
let endpointProfilesLoaded = false;
let endpointProfilesLoadPromise: Promise<void> | null = null;
let endpointProfilesSaveTimer: ReturnType<typeof setTimeout> | null = null;
let endpointProfilesPersistInFlight: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readEndpoint(value: unknown): UpstreamEndpoint | null {
  return value === 'chat' || value === 'messages' || value === 'responses'
    ? value
    : null;
}

function hydrateEndpointProfileState(raw: unknown): EndpointProfileState | null {
  if (!isRecord(raw)) return null;
  const preferredEndpoint = readEndpoint(raw.preferredEndpoint);
  const preferredUpdatedAtMs = Math.max(0, readFiniteNumber(raw.preferredUpdatedAtMs) ?? 0);
  const blockedSource = isRecord(raw.blockedUntilMsByEndpoint) ? raw.blockedUntilMsByEndpoint : {};
  const blockedUntilMsByEndpoint: Partial<Record<UpstreamEndpoint, number>> = {};

  for (const endpoint of ['chat', 'messages', 'responses'] as const) {
    const untilMs = readFiniteNumber(blockedSource[endpoint]);
    if (untilMs != null && untilMs > 0) {
      blockedUntilMsByEndpoint[endpoint] = untilMs;
    }
  }

  return {
    preferredEndpoint,
    preferredUpdatedAtMs,
    preferredReason: raw.preferredReason === 'success' || raw.preferredReason === 'suggested'
      ? raw.preferredReason
      : null,
    blockedUntilMsByEndpoint,
    probeAfterMs: Math.max(0, readFiniteNumber(raw.probeAfterMs) ?? 0) || null,
    lastProbeAtMs: Math.max(0, readFiniteNumber(raw.lastProbeAtMs) ?? 0) || null,
    lastProbeStatus: raw.lastProbeStatus === 'success' || raw.lastProbeStatus === 'failed'
      ? raw.lastProbeStatus
      : null,
  };
}

function cloneEndpointProfileState(state: EndpointProfileState): EndpointProfileState {
  return {
    preferredEndpoint: state.preferredEndpoint,
    preferredUpdatedAtMs: state.preferredUpdatedAtMs,
    preferredReason: state.preferredReason,
    blockedUntilMsByEndpoint: { ...state.blockedUntilMsByEndpoint },
    probeAfterMs: state.probeAfterMs,
    lastProbeAtMs: state.lastProbeAtMs,
    lastProbeStatus: state.lastProbeStatus,
  };
}

function getOrCreateEndpointProfileState(key: string, nowMs = Date.now()): EndpointProfileState {
  const existing = endpointProfiles.get(key);
  if (existing) return existing;

  const initial: EndpointProfileState = {
    preferredEndpoint: null,
    preferredUpdatedAtMs: nowMs,
    preferredReason: null,
    blockedUntilMsByEndpoint: {},
    probeAfterMs: null,
    lastProbeAtMs: null,
    lastProbeStatus: null,
  };
  endpointProfiles.set(key, initial);
  return initial;
}

function mergeEndpointProfileState(key: string, incoming: EndpointProfileState): void {
  const existing = endpointProfiles.get(key);
  if (!existing) {
    endpointProfiles.set(key, cloneEndpointProfileState(incoming));
    return;
  }

  if (
    incoming.preferredEndpoint
    && (
      !existing.preferredEndpoint
      || incoming.preferredUpdatedAtMs >= existing.preferredUpdatedAtMs
    )
  ) {
    existing.preferredEndpoint = incoming.preferredEndpoint;
    existing.preferredUpdatedAtMs = incoming.preferredUpdatedAtMs;
    existing.preferredReason = incoming.preferredReason;
  }

  for (const endpoint of ['chat', 'messages', 'responses'] as const) {
    const existingUntilMs = existing.blockedUntilMsByEndpoint[endpoint] ?? 0;
    const incomingUntilMs = incoming.blockedUntilMsByEndpoint[endpoint] ?? 0;
    if (incomingUntilMs > existingUntilMs) {
      existing.blockedUntilMsByEndpoint[endpoint] = incomingUntilMs;
    }
  }
  if ((incoming.probeAfterMs ?? 0) > (existing.probeAfterMs ?? 0)) {
    existing.probeAfterMs = incoming.probeAfterMs;
  }
  if ((incoming.lastProbeAtMs ?? 0) >= (existing.lastProbeAtMs ?? 0)) {
    existing.lastProbeAtMs = incoming.lastProbeAtMs;
    existing.lastProbeStatus = incoming.lastProbeStatus;
  }
}

function shouldPersistEndpointProfileState(state: EndpointProfileState, nowMs = Date.now()): boolean {
  const hasActiveBlock = Object.values(state.blockedUntilMsByEndpoint).some((untilMs) => (
    typeof untilMs === 'number' && untilMs > nowMs
  ));
  const preferredFresh = (
    !!state.preferredEndpoint
    && (state.preferredUpdatedAtMs + PREFERRED_ENDPOINT_TTL_MS) > nowMs
  );
  return hasActiveBlock || preferredFresh || state.probeAfterMs != null || state.lastProbeAtMs != null || state.lastProbeStatus != null;
}

function resolveEndpointProfileProbeAfterMs(
  blockedUntilMsByEndpoint: Partial<Record<UpstreamEndpoint, number>>,
  nowMs: number,
): number | null {
  const activeBlocks = Object.values(blockedUntilMsByEndpoint).filter((untilMs): untilMs is number => (
    typeof untilMs === 'number' && untilMs > nowMs
  ));
  if (activeBlocks.length === 0) return null;
  const nearestBlockUntilMs = Math.min(...activeBlocks);
  const remainingMs = Math.max(0, nearestBlockUntilMs - nowMs);
  return nowMs + Math.min(remainingMs, Math.max(10_000, Math.trunc(remainingMs * 0.5)));
}

function maybeDeleteEndpointProfileState(key: string, nowMs = Date.now()): void {
  const state = endpointProfiles.get(key);
  if (!state) return;
  if (!shouldPersistEndpointProfileState(state, nowMs)) {
    endpointProfiles.delete(key);
  }
}

function selectHalfOpenEndpoint(
  candidates: UpstreamEndpoint[],
  state: EndpointProfileState,
  nowMs: number,
): UpstreamEndpoint | null {
  if (candidates.length === 0) return null;

  const preferredFresh = (
    !!state.preferredEndpoint
    && (state.preferredUpdatedAtMs + PREFERRED_ENDPOINT_TTL_MS) > nowMs
    && candidates.includes(state.preferredEndpoint)
  );
  if (preferredFresh && state.preferredEndpoint) {
    return state.preferredEndpoint;
  }

  const ranked = [...candidates].sort((left, right) => {
    const leftUntilMs = state.blockedUntilMsByEndpoint[left] ?? Number.MAX_SAFE_INTEGER;
    const rightUntilMs = state.blockedUntilMsByEndpoint[right] ?? Number.MAX_SAFE_INTEGER;
    return leftUntilMs - rightUntilMs;
  });
  return ranked[0] || null;
}

function buildEndpointProfilePersistencePayload(nowMs = Date.now()): EndpointProfilePersistencePayload {
  const entries: Record<string, EndpointProfileState> = {};
  for (const [key, state] of endpointProfiles.entries()) {
    if (!shouldPersistEndpointProfileState(state, nowMs)) continue;
    entries[key] = cloneEndpointProfileState(state);
  }
  return {
    version: 1,
    savedAtMs: nowMs,
    entries,
  };
}

async function persistEndpointProfiles(): Promise<void> {
  if (endpointProfilesPersistInFlight) {
    await endpointProfilesPersistInFlight;
    return;
  }

  const persistTask = (async () => {
    try {
      const [{ upsertSetting }] = await Promise.all([
        import('../db/upsertSetting.js'),
      ]);
      await upsertSetting(
        UPSTREAM_PROTOCOL_PROFILE_SETTING_KEY,
        buildEndpointProfilePersistencePayload(),
      );
    } catch {
      // Tests may provide partial db mocks; persistence should degrade to memory-only.
    }
  })();

  endpointProfilesPersistInFlight = persistTask.finally(() => {
    if (endpointProfilesPersistInFlight === persistTask) {
      endpointProfilesPersistInFlight = null;
    }
  });

  await endpointProfilesPersistInFlight;
}

function scheduleEndpointProfilePersistence(): void {
  if (endpointProfilesSaveTimer) return;
  endpointProfilesSaveTimer = setTimeout(() => {
    endpointProfilesSaveTimer = null;
    void persistEndpointProfiles();
  }, PROFILE_PERSIST_DEBOUNCE_MS);
}

async function loadEndpointProfilesFromSettings(): Promise<void> {
  try {
    const [{ db, schema }] = await Promise.all([
      import('../db/index.js'),
    ]);

    if (!db || typeof (db as any).select !== 'function' || !schema?.settings) {
      return;
    }

    const row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, UPSTREAM_PROTOCOL_PROFILE_SETTING_KEY))
      .get();
    if (!row?.value) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    const entries = isRecord(parsed.entries) ? parsed.entries : {};
    for (const [key, rawState] of Object.entries(entries)) {
      const state = hydrateEndpointProfileState(rawState);
      if (!state) continue;
      mergeEndpointProfileState(key, state);
    }
  } catch {
    // Fall back to memory-only learning when db access is unavailable.
  }
}

async function ensureEndpointProfilesLoaded(): Promise<void> {
  if (endpointProfilesLoaded) return;
  if (!endpointProfilesLoadPromise) {
    endpointProfilesLoadPromise = (async () => {
      try {
        await loadEndpointProfilesFromSettings();
      } finally {
        endpointProfilesLoaded = true;
      }
    })();
  }
  await endpointProfilesLoadPromise;
}

export async function applyPersistedUpstreamEndpointPreference(
  candidates: UpstreamEndpoint[],
  key: string,
  nowMs = Date.now(),
): Promise<UpstreamEndpoint[]> {
  if (candidates.length <= 1) return candidates;

  await ensureEndpointProfilesLoaded();

  const state = endpointProfiles.get(key);
  if (!state) return candidates;

  const blocked = new Set<UpstreamEndpoint>();
  for (const endpoint of candidates) {
    const untilMs = state.blockedUntilMsByEndpoint[endpoint];
    if (typeof untilMs === 'number' && untilMs > nowMs) {
      blocked.add(endpoint);
    }
  }

  let next = candidates.filter((endpoint) => !blocked.has(endpoint));
  if (next.length === 0) {
    const halfOpenEndpoint = selectHalfOpenEndpoint(candidates, state, nowMs);
    if (halfOpenEndpoint) {
      state.lastProbeAtMs = nowMs;
      next = [halfOpenEndpoint];
    } else {
      next = [...candidates];
    }
  }

  const preferredFresh = (
    !!state.preferredEndpoint
    && (state.preferredUpdatedAtMs + PREFERRED_ENDPOINT_TTL_MS) > nowMs
  );
  if (preferredFresh && state.preferredEndpoint && next.includes(state.preferredEndpoint)) {
    next = [
      state.preferredEndpoint,
      ...next.filter((endpoint) => endpoint !== state.preferredEndpoint),
    ];
  }

  maybeDeleteEndpointProfileState(key, nowMs);
  return next;
}

export function recordPersistedUpstreamEndpointSuccess(input: {
  key: string;
  endpoint: UpstreamEndpoint;
  nowMs?: number;
}): void {
  const nowMs = input.nowMs ?? Date.now();
  const state = getOrCreateEndpointProfileState(input.key, nowMs);
  state.preferredEndpoint = input.endpoint;
  state.preferredUpdatedAtMs = nowMs;
  state.preferredReason = 'success';
  delete state.blockedUntilMsByEndpoint[input.endpoint];
  state.probeAfterMs = null;
  state.lastProbeAtMs = nowMs;
  state.lastProbeStatus = 'success';
  scheduleEndpointProfilePersistence();
}

export function recordPersistedUpstreamEndpointFailure(input: {
  key: string;
  endpoint: UpstreamEndpoint;
  suggestedEndpoint?: UpstreamEndpoint | null;
  blockTtlMs: number;
  nowMs?: number;
}): void {
  const nowMs = input.nowMs ?? Date.now();
  const state = getOrCreateEndpointProfileState(input.key, nowMs);
  state.blockedUntilMsByEndpoint[input.endpoint] = nowMs + input.blockTtlMs;
  if (input.suggestedEndpoint && input.suggestedEndpoint !== input.endpoint) {
    state.preferredEndpoint = input.suggestedEndpoint;
    state.preferredUpdatedAtMs = nowMs;
    state.preferredReason = 'suggested';
    delete state.blockedUntilMsByEndpoint[input.suggestedEndpoint];
  }
  state.probeAfterMs = resolveEndpointProfileProbeAfterMs(state.blockedUntilMsByEndpoint, nowMs);
  state.lastProbeAtMs = nowMs;
  state.lastProbeStatus = 'failed';

  scheduleEndpointProfilePersistence();
}

export function resetUpstreamProtocolProfileState(): void {
  endpointProfiles.clear();
  endpointProfilesLoaded = false;
  endpointProfilesLoadPromise = null;
  if (endpointProfilesSaveTimer) {
    clearTimeout(endpointProfilesSaveTimer);
    endpointProfilesSaveTimer = null;
  }
  endpointProfilesPersistInFlight = null;
}

export async function listPersistedUpstreamProtocolProfiles(nowMs = Date.now()): Promise<PersistedUpstreamProtocolProfileEntry[]> {
  await ensureEndpointProfilesLoaded();
  const entries: PersistedUpstreamProtocolProfileEntry[] = [];
  for (const [key, state] of endpointProfiles.entries()) {
    const activeBlocks = (['chat', 'messages', 'responses'] as const).filter((endpoint) => {
      const untilMs = state.blockedUntilMsByEndpoint[endpoint];
      return typeof untilMs === 'number' && untilMs > nowMs;
    });
    const hasFreshPreference = (
      !!state.preferredEndpoint
      && (state.preferredUpdatedAtMs + PREFERRED_ENDPOINT_TTL_MS) > nowMs
    );
    if (!hasFreshPreference && activeBlocks.length === 0) continue;
    entries.push({
      key,
      preferredEndpoint: state.preferredEndpoint,
      preferredUpdatedAtMs: state.preferredUpdatedAtMs,
      preferredReason: state.preferredReason,
      blockedUntilMsByEndpoint: { ...state.blockedUntilMsByEndpoint },
      activeBlocks,
      hasFreshPreference,
      probeAfterMs: state.probeAfterMs,
      probeReady: typeof state.probeAfterMs === 'number' && state.probeAfterMs <= nowMs,
      lastProbeAtMs: state.lastProbeAtMs,
      lastProbeStatus: state.lastProbeStatus,
    });
  }

  entries.sort((left, right) => (
    right.activeBlocks.length - left.activeBlocks.length
    || right.preferredUpdatedAtMs - left.preferredUpdatedAtMs
    || left.key.localeCompare(right.key, undefined, { sensitivity: 'base' })
  ));
  return entries;
}

export async function flushUpstreamProtocolProfilePersistence(): Promise<void> {
  if (endpointProfilesSaveTimer) {
    clearTimeout(endpointProfilesSaveTimer);
    endpointProfilesSaveTimer = null;
    await persistEndpointProfiles();
    return;
  }
  if (endpointProfilesPersistInFlight) {
    await endpointProfilesPersistInFlight;
  }
}

export async function clearPersistedUpstreamProtocolProfileState(): Promise<void> {
  try {
    const [{ db, schema }] = await Promise.all([
      import('../db/index.js'),
    ]);
    if (!db || typeof (db as any).delete !== 'function' || !schema?.settings) {
      return;
    }
    await db.delete(schema.settings)
      .where(eq(schema.settings.key, UPSTREAM_PROTOCOL_PROFILE_SETTING_KEY))
      .run();
  } catch {
    // Ignore cleanup failures in memory-only or mocked environments.
  }
}
