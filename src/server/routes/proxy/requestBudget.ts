import { config } from '../../config.js';

export type RequestBudget = {
  startedAtMs: number;
  totalBudgetMs: number;
  getRemainingMs: () => number;
  isExpired: () => boolean;
  buildTimeoutMessage: () => string;
};

export function createRequestBudget(totalBudgetMs = config.upstreamRequestBudgetMs): RequestBudget {
  const startedAtMs = Date.now();
  const normalizedBudgetMs = Math.max(1_000, totalBudgetMs);
  return {
    startedAtMs,
    totalBudgetMs: normalizedBudgetMs,
    getRemainingMs: () => Math.max(0, normalizedBudgetMs - (Date.now() - startedAtMs)),
    isExpired: () => (Date.now() - startedAtMs) >= normalizedBudgetMs,
    buildTimeoutMessage: () => `upstream request budget exceeded after ${normalizedBudgetMs}ms`,
  };
}

export function shouldRetryWithinBudget(
  retryCount: number,
  maxRetries: number,
  budget: RequestBudget,
): boolean {
  return retryCount < maxRetries && !budget.isExpired() && budget.getRemainingMs() > 0;
}
