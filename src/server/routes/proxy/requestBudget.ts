import { config } from '../../config.js';

export type RequestBudget = {
  startedAtMs: number;
  totalBudgetMs: number;
  getRemainingMs: () => number;
  isExpired: () => boolean;
  buildTimeoutMessage: () => string;
  getPerAttemptTimeoutMs: (options?: { preferFastFail?: boolean; hardCapMs?: number }) => number;
  getStreamFirstByteTimeoutMs: (options?: { preferFastFail?: boolean; hardCapMs?: number }) => number;
};

export function shouldPreferFastFailForSelected(selected?: { availableChannelCount?: number | null } | null): boolean {
  if (typeof selected?.availableChannelCount === 'number' && Number.isFinite(selected.availableChannelCount)) {
    return selected.availableChannelCount > 1;
  }
  return true;
}

type RetryBackoffInput = {
  retryCount: number;
  maxRetries: number;
  budget: RequestBudget;
  status?: number | null;
  retryAfterHeader?: string | null;
};

type RetryBackoffKind = 'retry_after' | 'rate_limit' | 'timeout' | 'transient' | 'other';

type RetryBackoffMetricBucket = {
  totalMs: number;
  count: number;
};

type RetryBackoffMetricsState = {
  totalMs: number;
  count: number;
  lastDelayMs: number;
  retryAfterHonoredCount: number;
  budgetExhaustedCount: number;
  byKind: Record<RetryBackoffKind, RetryBackoffMetricBucket>;
  byStatus: Record<string, RetryBackoffMetricBucket>;
};

function createMetricBucket(): RetryBackoffMetricBucket {
  return {
    totalMs: 0,
    count: 0,
  };
}

const retryBackoffMetricsState: RetryBackoffMetricsState = {
  totalMs: 0,
  count: 0,
  lastDelayMs: 0,
  retryAfterHonoredCount: 0,
  budgetExhaustedCount: 0,
  byKind: {
    retry_after: createMetricBucket(),
    rate_limit: createMetricBucket(),
    timeout: createMetricBucket(),
    transient: createMetricBucket(),
    other: createMetricBucket(),
  },
  byStatus: {},
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(status?: number | null): number | null {
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return null;
  }
  return Math.trunc(status);
}

function classifyRetryBackoffKind(status?: number | null, retryAfterHeader?: string | null): RetryBackoffKind {
  if (parseRetryAfterMs(retryAfterHeader) != null) {
    return 'retry_after';
  }
  const normalizedStatus = normalizeStatus(status);
  if (normalizedStatus === 429) return 'rate_limit';
  if (normalizedStatus === 408 || normalizedStatus === 409 || normalizedStatus === 425) return 'timeout';
  if (normalizedStatus == null || normalizedStatus === 0 || normalizedStatus >= 500) return 'transient';
  return 'other';
}

function recordRetryBackoff(
  delayMs: number,
  options?: {
    status?: number | null;
    retryAfterHeader?: string | null;
  },
): void {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const normalizedDelayMs = Math.max(0, Math.trunc(delayMs));
  const kind = classifyRetryBackoffKind(options?.status, options?.retryAfterHeader);
  const statusKey = String(normalizeStatus(options?.status) ?? 'unknown');
  retryBackoffMetricsState.totalMs += Math.max(0, Math.trunc(delayMs));
  retryBackoffMetricsState.count += 1;
  retryBackoffMetricsState.lastDelayMs = normalizedDelayMs;
  if (kind === 'retry_after') {
    retryBackoffMetricsState.retryAfterHonoredCount += 1;
  }
  retryBackoffMetricsState.byKind[kind].totalMs += normalizedDelayMs;
  retryBackoffMetricsState.byKind[kind].count += 1;
  retryBackoffMetricsState.byStatus[statusKey] ??= createMetricBucket();
  retryBackoffMetricsState.byStatus[statusKey].totalMs += normalizedDelayMs;
  retryBackoffMetricsState.byStatus[statusKey].count += 1;
}

function recordBudgetExhausted(): void {
  retryBackoffMetricsState.budgetExhaustedCount += 1;
}

function applyRetryJitter(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  const jitterFactor = 0.9 + (Math.random() * 0.2);
  return Math.max(0, Math.round(delayMs * jitterFactor));
}

export function createRequestBudget(totalBudgetMs = config.upstreamRequestBudgetMs): RequestBudget {
  const startedAtMs = Date.now();
  const normalizedBudgetMs = Math.max(1_000, totalBudgetMs);
  const resolveCappedTimeout = (hardCap: number) => {
    const remainingMs = Math.max(0, normalizedBudgetMs - (Date.now() - startedAtMs));
    return Math.max(1_000, Math.min(remainingMs, hardCap));
  };
  return {
    startedAtMs,
    totalBudgetMs: normalizedBudgetMs,
    getRemainingMs: () => Math.max(0, normalizedBudgetMs - (Date.now() - startedAtMs)),
    isExpired: () => (Date.now() - startedAtMs) >= normalizedBudgetMs,
    buildTimeoutMessage: () => `upstream request budget exceeded after ${normalizedBudgetMs}ms`,
    getPerAttemptTimeoutMs: (options) => {
      const fastFailCap = Number.isFinite(options?.hardCapMs as number)
        ? Math.max(1_000, Math.trunc(options?.hardCapMs as number))
        : Math.min(config.upstreamFastFailTimeoutMs, config.upstreamRequestTimeoutMs);
      const hardCap = options?.preferFastFail ? fastFailCap : config.upstreamRequestTimeoutMs;
      return resolveCappedTimeout(hardCap);
    },
    getStreamFirstByteTimeoutMs: (options) => {
      const fastFailCap = Number.isFinite(options?.hardCapMs as number)
        ? Math.max(1_000, Math.trunc(options?.hardCapMs as number))
        : config.upstreamStreamFirstByteTimeoutMs;
      const hardCap = options?.preferFastFail
        ? Math.min(fastFailCap, config.upstreamStreamFirstByteTimeoutMs)
        : config.upstreamStreamFirstByteTimeoutMs;
      return resolveCappedTimeout(hardCap);
    },
  };
}

export function shouldRetryWithinBudget(
  retryCount: number,
  maxRetries: number,
  budget: RequestBudget,
): boolean {
  return retryCount < maxRetries && !budget.isExpired() && budget.getRemainingMs() > 0;
}

export function parseRetryAfterMs(rawValue?: string | null, nowMs = Date.now()): number | null {
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

export function resolveRetryBackoffMs(
  retryCount: number,
  status?: number | null,
  retryAfterHeader?: string | null,
): number {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs != null) return retryAfterMs;

  const normalizedRetryCount = Math.max(0, Math.trunc(retryCount));
  const attemptNumber = normalizedRetryCount + 1;
  const normalizedStatus = normalizeStatus(status) ?? 0;

  if (normalizedStatus === 429) {
    return applyRetryJitter(Math.min(3_000, 750 * attemptNumber));
  }
  if (normalizedStatus === 408 || normalizedStatus === 409 || normalizedStatus === 425) {
    return applyRetryJitter(Math.min(1_500, 300 * attemptNumber));
  }
  if (normalizedStatus === 0 || normalizedStatus >= 500) {
    return applyRetryJitter(Math.min(1_200, 200 * attemptNumber));
  }

  return 0;
}

export async function waitForRetryWithinBudget(input: RetryBackoffInput): Promise<boolean> {
  if (!shouldRetryWithinBudget(input.retryCount, input.maxRetries, input.budget)) {
    return false;
  }

  const delayMs = resolveRetryBackoffMs(input.retryCount, input.status, input.retryAfterHeader);
  if (delayMs <= 0) {
    return true;
  }

  const remainingMs = input.budget.getRemainingMs();
  if (delayMs >= remainingMs) {
    recordBudgetExhausted();
    return false;
  }

  recordRetryBackoff(delayMs, {
    status: input.status,
    retryAfterHeader: input.retryAfterHeader,
  });
  await sleep(delayMs);
  return shouldRetryWithinBudget(input.retryCount, input.maxRetries, input.budget);
}

export function getRetryBackoffMetrics() {
  return {
    totalMs: retryBackoffMetricsState.totalMs,
    count: retryBackoffMetricsState.count,
    lastDelayMs: retryBackoffMetricsState.lastDelayMs,
    retryAfterHonoredCount: retryBackoffMetricsState.retryAfterHonoredCount,
    budgetExhaustedCount: retryBackoffMetricsState.budgetExhaustedCount,
    byKind: {
      retry_after: { ...retryBackoffMetricsState.byKind.retry_after },
      rate_limit: { ...retryBackoffMetricsState.byKind.rate_limit },
      timeout: { ...retryBackoffMetricsState.byKind.timeout },
      transient: { ...retryBackoffMetricsState.byKind.transient },
      other: { ...retryBackoffMetricsState.byKind.other },
    },
    byStatus: Object.fromEntries(
      Object.entries(retryBackoffMetricsState.byStatus).map(([status, bucket]) => [status, { ...bucket }]),
    ),
  };
}

export function resetRetryBackoffMetrics(): void {
  retryBackoffMetricsState.totalMs = 0;
  retryBackoffMetricsState.count = 0;
  retryBackoffMetricsState.lastDelayMs = 0;
  retryBackoffMetricsState.retryAfterHonoredCount = 0;
  retryBackoffMetricsState.budgetExhaustedCount = 0;
  for (const bucket of Object.values(retryBackoffMetricsState.byKind)) {
    bucket.totalMs = 0;
    bucket.count = 0;
  }
  for (const status of Object.keys(retryBackoffMetricsState.byStatus)) {
    delete retryBackoffMetricsState.byStatus[status];
  }
}
