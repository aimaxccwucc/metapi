export type ModelCircuitState = 'closed' | 'open' | 'half_open';

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
  const entry = normalizeOpenState(ensureEntry(channelId, modelName), nowMs);
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
  const entry = normalizeOpenState(ensureEntry(channelId, modelName), nowMs);
  if (status.state === 'half_open' && !entry.probeInFlight) {
    entry.probeInFlight = true;
    return true;
  }
  return false;
}

export function recordModelCircuitSuccess(channelId: number, modelName: string, nowMs = Date.now()): void {
  const entry = ensureEntry(channelId, modelName);
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
  category: 'network' | 'server' | 'rate_limit' | 'payload_too_large' | 'model_unsupported' | 'auth' | 'bad_request' | 'unknown',
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

export function resetModelCircuit(channelId: number, modelName: string): void {
  const key = getCircuitKey(channelId, modelName);
  circuitEntries.delete(key);
}
