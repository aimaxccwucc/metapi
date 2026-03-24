import { describe, expect, it } from 'vitest';
import {
  AUTH_SESSION_DURATION_MS,
  COOKIE_AUTH_SESSION_SENTINEL,
  clearAuthSession,
  getAuthToken,
  getBearerAuthToken,
  hasValidAuthSession,
  persistAuthSession,
} from './authSession.js';

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
}

describe('authSession', () => {
  it('persists token with expiration and reads it before expiry', () => {
    const storage = createMemoryStorage();
    persistAuthSession(storage, 'token-1', 60_000, 1_000);

    expect(getAuthToken(storage, 10_000)).toBe(COOKIE_AUTH_SESSION_SENTINEL);
    expect(getBearerAuthToken(storage, 10_000)).toBeNull();
    expect(hasValidAuthSession(storage, 10_000)).toBe(true);
  });

  it('clears expired session automatically', () => {
    const storage = createMemoryStorage();
    persistAuthSession(storage, 'token-2', 60_000, 1_000);

    expect(getAuthToken(storage, 100_000)).toBeNull();
    expect(hasValidAuthSession(storage, 100_000)).toBe(false);
  });

  it('supports explicit logout', () => {
    const storage = createMemoryStorage();
    persistAuthSession(storage, 'token-3', AUTH_SESSION_DURATION_MS, 1_000);

    clearAuthSession(storage);

    expect(getAuthToken(storage, 2_000)).toBeNull();
  });

  it('clears session when persisting an empty token', () => {
    const storage = createMemoryStorage();
    persistAuthSession(storage, 'token-3', AUTH_SESSION_DURATION_MS, 1_000);

    persistAuthSession(storage, '', AUTH_SESSION_DURATION_MS, 2_000);

    expect(getAuthToken(storage, 3_000)).toBeNull();
    expect(getBearerAuthToken(storage, 3_000)).toBeNull();
  });
});
