import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRequestBudget,
  getRetryBackoffMetrics,
  parseRetryAfterMs,
  resetRetryBackoffMetrics,
  resolveRetryBackoffMs,
  shouldRetryWithinBudget,
  waitForRetryWithinBudget,
} from './requestBudget.js';

describe('requestBudget', () => {
  afterEach(() => {
    resetRetryBackoffMetrics();
  });

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
      expect(budget.getPerAttemptTimeoutMs({ preferFastFail: true })).toBe(1000);
      expect(budget.getStreamFirstByteTimeoutMs({ preferFastFail: true })).toBe(1000);
      expect(budget.isExpired()).toBe(false);

      vi.advanceTimersByTime(550);
      expect(budget.getRemainingMs()).toBe(0);
      expect(budget.isExpired()).toBe(true);
      expect(budget.buildTimeoutMessage()).toBe('upstream request budget exceeded after 1000ms');
      expect(budget.getPerAttemptTimeoutMs()).toBe(1000);
      expect(budget.getStreamFirstByteTimeoutMs()).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps stream first-byte timeout independently from non-stream attempt timeout', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T09:05:00.000Z'));
    try {
      const budget = createRequestBudget(60_000);
      expect(budget.getPerAttemptTimeoutMs()).toBe(20_000);
      expect(budget.getStreamFirstByteTimeoutMs()).toBe(45_000);
      expect(budget.getStreamFirstByteTimeoutMs({ preferFastFail: true })).toBe(10_000);
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

  it('parses Retry-After headers as seconds or absolute dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T09:20:00.000Z'));
    try {
      expect(parseRetryAfterMs('2')).toBe(2000);
      expect(parseRetryAfterMs('Tue, 31 Mar 2026 09:20:03 GMT')).toBe(3000);
      expect(parseRetryAfterMs('invalid')).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies bounded backoff for transient failures and honors Retry-After when present', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T09:30:00.000Z'));
    try {
      expect(resolveRetryBackoffMs(0, 429)).toBe(750);
      expect(resolveRetryBackoffMs(1, 503)).toBe(400);
      expect(resolveRetryBackoffMs(0, 429, '5')).toBe(5000);

      const budget = createRequestBudget(5000);
      const retryPromise = waitForRetryWithinBudget({
        retryCount: 0,
        maxRetries: 2,
        budget,
        status: 429,
      });
      await vi.advanceTimersByTimeAsync(749);
      expect(await Promise.race([retryPromise, Promise.resolve('pending')])).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await expect(retryPromise).resolves.toBe(true);
      expect(getRetryBackoffMetrics()).toEqual({
        totalMs: 750,
        count: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to wait when the retry delay would exhaust the remaining budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T09:40:00.000Z'));
    try {
      const budget = createRequestBudget(1000);
      await vi.advanceTimersByTimeAsync(600);
      await expect(waitForRetryWithinBudget({
        retryCount: 0,
        maxRetries: 2,
        budget,
        status: 429,
      })).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
