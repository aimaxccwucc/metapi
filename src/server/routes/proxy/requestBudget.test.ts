import { describe, expect, it, vi } from 'vitest';
import { createRequestBudget, shouldRetryWithinBudget } from './requestBudget.js';

describe('requestBudget', () => {
  it('normalizes too-small budgets and expires based on elapsed time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T09:00:00.000Z'));
    try {
      const budget = createRequestBudget(250);
      expect(budget.totalBudgetMs).toBe(1000);
      expect(budget.getRemainingMs()).toBe(1000);
      expect(budget.isExpired()).toBe(false);

      vi.advanceTimersByTime(450);
      expect(budget.getRemainingMs()).toBe(550);
      expect(budget.isExpired()).toBe(false);

      vi.advanceTimersByTime(550);
      expect(budget.getRemainingMs()).toBe(0);
      expect(budget.isExpired()).toBe(true);
      expect(budget.buildTimeoutMessage()).toBe('upstream request budget exceeded after 1000ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows retries only when retry budget and retry count both permit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T09:10:00.000Z'));
    try {
      const budget = createRequestBudget(1200);
      expect(shouldRetryWithinBudget(0, 2, budget)).toBe(true);
      expect(shouldRetryWithinBudget(2, 2, budget)).toBe(false);

      vi.advanceTimersByTime(1201);
      expect(shouldRetryWithinBudget(0, 2, budget)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
