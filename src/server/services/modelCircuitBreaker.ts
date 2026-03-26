export type ModelCircuitState = 'closed' | 'open' | 'half_open';
export type ModelCircuitFailureCategory =
  | 'network'
  | 'server'
  | 'rate_limit'
  | 'payload_too_large'
  | 'model_unsupported'
  | 'auth'
  | 'bad_request'
  | 'unknown';

export type ModelCircuitSnapshot = {
  channelId: number;
  modelName: string;
  state: ModelCircuitState;
  failCount: number;
  openedAt: number | null;
  openUntil: number | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  probeInFlight: boolean;
};

type CircuitEntry = ModelCircuitSnapshot;

export type ModelCircuitStatusView = {
  state: ModelCircuitState;
  isOpen: boolean;
  isHalfOpen: boolean;
  openUntil: number | null;
  reason: string;
  effectiveMultiplier: number;
};

export type ModelCircuitSnapshotView = ModelCircuitSnapshot & {
  status: ModelCircuitStatusView;
};

const circuitEntries = new Map<string, CircuitEntry>();

const FAILURE_THRESHOLDS = {
  auth: 1,
  model_unsupported: 1,
  payload_too_large: 2,
  rate_limit: 2,
  server: 3,
  network: 3,
  bad_request: 3,
  unknown: 4,
} as const;

const OPEN_DURATIONS_MS = {
  auth: 30 * 60 * 1000,
  model_unsupported: 20 * 60 * 1000,
  payload_too_large: 10 * 60 * 1000,
  rate_limit: 4 * 60 * 1000,
  server: 90 * 1000,
  network: 60 * 1000,
  bad_request: 3 * 60 * 1000,
  unknown: 60 * 1000,
} as const;

function getCircuitKey(channelId: number, modelName: string): string {
  return `${channelId}::${modelName.trim().toLowerCase()}`;
}

function getEntry(channelId: number, modelName: string): CircuitEntry | null {
  const normalizedModelName = modelName.trim().toLowerCase();
  if (!normalizedModelName) return null;
  return circuitEntries.get(getCircuitKey(channelId, normalizedModelName)) ?? null;
}

function ensureEntry(channelId: number, modelName: string): CircuitEntry {
  const normalizedModelName = modelName.trim().toLowerCase();
  const key = getCircuitKey(channelId, normalizedModelName);
  const existing = circuitEntries.get(key);
  if (existing) return existing;
  const created: CircuitEntry = {
    channelId,
    modelName: normalizedModelName,
    state: 'closed',
    failCount: 0,
    openedAt: null,
    openUntil: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    probeInFlight: false,
  };
  circuitEntries.set(key, created);
  return created;
}

function normalizeOpenState(entry: CircuitEntry, nowMs: number): CircuitEntry {
  if (entry.state === 'open' && entry.openUntil && nowMs >= entry.openUntil) {
    entry.state = 'half_open';
    entry.probeInFlight = false;
  }
  return entry;
}

export function getModelCircuitStatus(channelId: number, modelName: string, nowMs = Date.now()): ModelCircuitStatusView {
  const existing = getEntry(channelId, modelName);
  if (!existing) {
    return {
      state: 'closed',
      isOpen: false,
      isHalfOpen: false,
      openUntil: null,
      reason: '模型熔断关闭',
      effectiveMultiplier: 1,
    };
  }

  const entry = normalizeOpenState(existing, nowMs);
  if (entry.state === 'open' && entry.openUntil && entry.openUntil > nowMs) {
    return {
      state: 'open',
      isOpen: true,
      isHalfOpen: false,
      openUntil: entry.openUntil,
      reason: `模型熔断中，${Math.ceil((entry.openUntil - nowMs) / 1000)}s 后重试`,
      effectiveMultiplier: 0.05,
    };
  }
  if (entry.state === 'half_open') {
    return {
      state: 'half_open',
      isOpen: false,
      isHalfOpen: true,
      openUntil: entry.openUntil,
      reason: entry.probeInFlight ? '模型熔断半开探测中' : '模型熔断半开，允许一次探测',
      effectiveMultiplier: 0.35,
    };
  }
  return {
    state: 'closed',
    isOpen: false,
    isHalfOpen: false,
    openUntil: null,
    reason: '模型熔断关闭',
    effectiveMultiplier: 1,
  };
}

export function canUseModelCircuit(channelId: number, modelName: string, nowMs = Date.now()): boolean {
  const status = getModelCircuitStatus(channelId, modelName, nowMs);
  if (status.state === 'closed') return true;
  const existing = getEntry(channelId, modelName);
  if (!existing) return true;
  const entry = normalizeOpenState(existing, nowMs);
  if (status.state === 'half_open' && !entry.probeInFlight) {
    entry.probeInFlight = true;
    return true;
  }
  return false;
}

export function recordModelCircuitSuccess(channelId: number, modelName: string, nowMs = Date.now()): void {
  const entry = getEntry(channelId, modelName);
  if (!entry) return;
  entry.state = 'closed';
  entry.failCount = 0;
  entry.openedAt = null;
  entry.openUntil = null;
  entry.lastSuccessAt = nowMs;
  entry.probeInFlight = false;
}

export function recordModelCircuitFailure(
  channelId: number,
  modelName: string,
  category: ModelCircuitFailureCategory,
  nowMs = Date.now(),
): void {
  const entry = ensureEntry(channelId, modelName);
  const threshold = FAILURE_THRESHOLDS[category] ?? 3;
  const durationMs = OPEN_DURATIONS_MS[category] ?? 60_000;
  entry.lastErrorAt = nowMs;
  entry.probeInFlight = false;

  if (entry.state === 'half_open') {
    entry.state = 'open';
    entry.failCount = threshold;
    entry.openedAt = nowMs;
    entry.openUntil = nowMs + durationMs;
    return;
  }

  entry.failCount += 1;
  if (entry.failCount >= threshold) {
    entry.state = 'open';
    entry.openedAt = nowMs;
    entry.openUntil = nowMs + durationMs;
  }
}

export function openModelCircuitImmediately(
  channelId: number,
  modelName: string,
  category: ModelCircuitFailureCategory,
  nowMs = Date.now(),
): void {
  const entry = ensureEntry(channelId, modelName);
  const threshold = FAILURE_THRESHOLDS[category] ?? 3;
  const durationMs = OPEN_DURATIONS_MS[category] ?? 60_000;
  entry.state = 'open';
  entry.failCount = Math.max(entry.failCount + 1, threshold);
  entry.openedAt = nowMs;
  entry.openUntil = nowMs + durationMs;
  entry.lastErrorAt = nowMs;
  entry.probeInFlight = false;
}

export function resetModelCircuit(channelId: number, modelName: string): void {
  const key = getCircuitKey(channelId, modelName);
  circuitEntries.delete(key);
}

export function resetModelCircuitsForChannels(channelIds: number[]): number {
  const normalizedIds = new Set(
    channelIds
      .map((channelId) => Math.trunc(channelId))
      .filter((channelId) => Number.isFinite(channelId) && channelId > 0),
  );
  if (normalizedIds.size === 0) return 0;

  let cleared = 0;
  for (const [key, entry] of circuitEntries.entries()) {
    if (!normalizedIds.has(entry.channelId)) continue;
    circuitEntries.delete(key);
    cleared += 1;
  }
  return cleared;
}

export function getModelCircuitSnapshots(nowMs = Date.now()): ModelCircuitSnapshotView[] {
  const stateRank: Record<ModelCircuitState, number> = {
    open: 0,
    half_open: 1,
    closed: 2,
  };

  const snapshots = Array.from(circuitEntries.values())
    .map((entry) => {
      const status = getModelCircuitStatus(entry.channelId, entry.modelName, nowMs);
      const normalized = getEntry(entry.channelId, entry.modelName) || entry;
      return {
        ...normalized,
        status,
      };
    })
    .sort((left, right) => (
      stateRank[left.state] - stateRank[right.state]
      || right.failCount - left.failCount
      || (right.lastErrorAt ?? 0) - (left.lastErrorAt ?? 0)
      || left.channelId - right.channelId
      || left.modelName.localeCompare(right.modelName, undefined, { sensitivity: 'base' })
    ));

  return snapshots;
}

export function resetAllModelCircuits(): number {
  const cleared = circuitEntries.size;
  circuitEntries.clear();
  return cleared;
}
