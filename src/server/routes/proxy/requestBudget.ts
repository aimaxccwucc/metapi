import { config } from '../../config.js';

export type RequestBudget = {
  startedAtMs: number;
  totalBudgetMs: number;
  getRemainingMs: () => number;
  isExpired: () => boolean;
  buildTimeoutMessage: () => string;
  getPerAttemptTimeoutMs: (options?: { preferFastFail?: boolean }) => number;
};

type RetryBackoffInput = {
  retryCount: number;
  maxRetries: number;
  budget: RequestBudget;
  status?: number | null;
  retryAfterHeader?: string | null;
};

type RetryBackoffMetricsState = {
  totalMs: number;
  count: number;
};

const retryBackoffMetricsState: RetryBackoffMetricsState = {
  totalMs: 0,
  count: 0,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordRetryBackoff(delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  retryBackoffMetricsState.totalMs += Math.max(0, Math.trunc(delayMs));
  retryBackoffMetricsState.count += 1;
}

export function createRequestBudget(totalBudgetMs = config.upstreamRequestBudgetMs): RequestBudget {
  const startedAtMs = Date.now();
  const normalizedBudgetMs = Math.max(1_000, totalBudgetMs);
  return {
    startedAtMs,
    totalBudgetMs: normalizedBudgetMs,
    getRemainingMs: () => Math.max(0, normalizedBudgetMs - (Date.now() - startedAtMs)),
    isExpired: () => (Date.now() - startedAtMs) >= normalizedBudgetMs,
    buildTimeoutMessage: () => `upstream request budget exceeded after ${normalizedBudgetMs}ms`,
    getPerAttemptTimeoutMs: (options) => {
      const remainingMs = Math.max(0, normalizedBudgetMs - (Date.now() - startedAtMs));
      const hardCap = options?.preferFastFail ? 10_000 : config.upstreamRequestTimeoutMs;
      return Math.max(1_000, Math.min(remainingMs, hardCap));
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
  const normalizedStatus = typeof status === 'number' && Number.isFinite(status)
    ? Math.trunc(status)
    : 0;

  if (normalizedStatus === 429) {
    return Math.min(3_000, 750 * attemptNumber);
  }
  if (normalizedStatus === 408 || normalizedStatus === 409 || normalizedStatus === 425) {
    return Math.min(1_500, 300 * attemptNumber);
  }
  if (normalizedStatus === 0 || normalizedStatus >= 500) {
    return Math.min(1_200, 200 * attemptNumber);
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
    return false;
  }

  recordRetryBackoff(delayMs);
  await sleep(delayMs);
  return shouldRetryWithinBudget(input.retryCount, input.maxRetries, input.budget);
}

export function getRetryBackoffMetrics() {
  return {
    totalMs: retryBackoffMetricsState.totalMs,
    count: retryBackoffMetricsState.count,
  };
}

export function resetRetryBackoffMetrics(): void {
  retryBackoffMetricsState.totalMs = 0;
  retryBackoffMetricsState.count = 0;
}
