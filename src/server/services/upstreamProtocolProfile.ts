import { eq } from 'drizzle-orm';

type UpstreamEndpoint = 'chat' | 'messages' | 'responses';

type EndpointProfileState = {
  preferredEndpoint: UpstreamEndpoint | null;
  preferredUpdatedAtMs: number;
  blockedUntilMsByEndpoint: Partial<Record<UpstreamEndpoint, number>>;
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
    blockedUntilMsByEndpoint,
  };
}

function cloneEndpointProfileState(state: EndpointProfileState): EndpointProfileState {
  return {
    preferredEndpoint: state.preferredEndpoint,
    preferredUpdatedAtMs: state.preferredUpdatedAtMs,
    blockedUntilMsByEndpoint: { ...state.blockedUntilMsByEndpoint },
  };
}

function getOrCreateEndpointProfileState(key: string, nowMs = Date.now()): EndpointProfileState {
  const existing = endpointProfiles.get(key);
  if (existing) return existing;

  const initial: EndpointProfileState = {
    preferredEndpoint: null,
    preferredUpdatedAtMs: nowMs,
    blockedUntilMsByEndpoint: {},
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
  }

  for (const endpoint of ['chat', 'messages', 'responses'] as const) {
    const existingUntilMs = existing.blockedUntilMsByEndpoint[endpoint] ?? 0;
    const incomingUntilMs = incoming.blockedUntilMsByEndpoint[endpoint] ?? 0;
    if (incomingUntilMs > existingUntilMs) {
      existing.blockedUntilMsByEndpoint[endpoint] = incomingUntilMs;
    }
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
  return hasActiveBlock || preferredFresh;
}

function maybeDeleteEndpointProfileState(key: string, nowMs = Date.now()): void {
  const state = endpointProfiles.get(key);
  if (!state) return;
  if (!shouldPersistEndpointProfileState(state, nowMs)) {
    endpointProfiles.delete(key);
  }
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
    next = [...candidates];
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
  delete state.blockedUntilMsByEndpoint[input.endpoint];
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
    delete state.blockedUntilMsByEndpoint[input.suggestedEndpoint];
  }

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
