const AUTH_TOKEN_STORAGE_KEY = 'auth_token';
const AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY = 'auth_token_expires_at';
export const COOKIE_AUTH_SESSION_SENTINEL = '__cookie_session__';
export const AUTH_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

export function clearAuthSession(storage?: StorageLike | null): void {
  const target = resolveStorage(storage);
  if (!target) return;
  target.removeItem(AUTH_TOKEN_STORAGE_KEY);
  target.removeItem(AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY);
}

export function persistAuthSession(
  storage: StorageLike | null | undefined,
  token: string,
  ttlMs = AUTH_SESSION_DURATION_MS,
  nowMs = Date.now(),
): void {
  const target = resolveStorage(storage);
  if (!target) return;

  const cleanToken = (token || '').trim();
  if (!cleanToken) {
    clearAuthSession(target);
    return;
  }

  const expiresAt = nowMs + Math.max(1, Math.trunc(ttlMs));
  target.setItem(AUTH_TOKEN_STORAGE_KEY, COOKIE_AUTH_SESSION_SENTINEL);
  target.setItem(AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY, String(expiresAt));
}

export function getAuthToken(storage?: StorageLike | null, nowMs = Date.now()): string | null {
  const target = resolveStorage(storage);
  if (!target) return null;

  const token = (target.getItem(AUTH_TOKEN_STORAGE_KEY) || '').trim();
  if (!token) return null;

  const expiresAtRaw = target.getItem(AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY);
  if (!expiresAtRaw) {
    const expiresAt = nowMs + AUTH_SESSION_DURATION_MS;
    target.setItem(AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY, String(expiresAt));
    return token;
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    clearAuthSession(target);
    return null;
  }

  return token;
}

export function getBearerAuthToken(storage?: StorageLike | null, nowMs = Date.now()): string | null {
  const token = getAuthToken(storage, nowMs);
  if (!token || token === COOKIE_AUTH_SESSION_SENTINEL) return null;
  return token;
}

export function hasValidAuthSession(storage?: StorageLike | null, nowMs = Date.now()): boolean {
  return !!getAuthToken(storage, nowMs);
}
