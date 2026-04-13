import { AsyncLocalStorage } from 'node:async_hooks';
import { upsertSetting } from '../db/upsertSetting.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

export type StoredCfCookie = {
  cfClearance: string;
  userAgent: string;
  obtainedAt: string;
  expiresAt: string;
  source: 'flaresolverr' | 'manual';
};

const CF_COOKIE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CF_COOKIE_REFRESH_MARGIN_MS = 30 * 60 * 1000; // refresh 30 min before expiry

function settingKey(siteId: number): string {
  return `cf_cookie_${siteId}`;
}

export function buildCfCookieEntry(
  cfClearance: string,
  userAgent: string,
  source: 'flaresolverr' | 'manual',
): StoredCfCookie {
  const now = Date.now();
  return {
    cfClearance,
    userAgent,
    obtainedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CF_COOKIE_TTL_MS).toISOString(),
    source,
  };
}

export function isCfCookieValid(entry: StoredCfCookie | null): boolean {
  if (!entry?.cfClearance || !entry.expiresAt) return false;
  return Date.now() < new Date(entry.expiresAt).getTime();
}

export function isCfCookieNearExpiry(entry: StoredCfCookie): boolean {
  const expiresAt = new Date(entry.expiresAt).getTime();
  return Date.now() > expiresAt - CF_COOKIE_REFRESH_MARGIN_MS;
}

export async function getCfCookie(siteId: number): Promise<StoredCfCookie | null> {
  try {
    const row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, settingKey(siteId)))
      .get();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as StoredCfCookie;
    if (!parsed.cfClearance) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setCfCookie(siteId: number, entry: StoredCfCookie): Promise<void> {
  await upsertSetting(settingKey(siteId), entry);
}

export async function removeCfCookie(siteId: number): Promise<void> {
  await upsertSetting(settingKey(siteId), null);
}

// --- AsyncLocalStorage cookie override (per-request injection) ---

export type CfOverrideContext = {
  cookies: Record<string, string>;
  userAgent?: string;
};

const cfCookieStore = new AsyncLocalStorage<CfOverrideContext | null>();

export function withCfCookieOverride<T>(
  cookies: Record<string, string> | null,
  fn: () => Promise<T>,
  userAgent?: string,
): Promise<T> {
  if (!cookies || Object.keys(cookies).length === 0) return fn();
  return cfCookieStore.run({ cookies, userAgent }, fn);
}

export function getCfCookieOverride(): CfOverrideContext | null {
  return cfCookieStore.getStore() ?? null;
}

// --- Per-site refresh lock (prevents concurrent FlareSolverr calls) ---

const refreshLocks = new Map<number, {
  promise: Promise<StoredCfCookie | null>;
  resolve: (value: StoredCfCookie | null) => void;
}>();

/**
 * Try to acquire the refresh lock for a site.
 * Returns `{ locked: false, release }` if the lock was acquired (caller should proceed).
 * Returns `{ locked: true }` if another caller holds the lock.
 */
export function acquireCfRefreshLock(siteId: number): {
  locked: boolean;
  release: (value: StoredCfCookie | null) => void;
} {
  const existing = refreshLocks.get(siteId);
  if (existing) {
    return { locked: true, release: () => {} };
  }

  let resolve!: (value: StoredCfCookie | null) => void;
  const promise = new Promise<StoredCfCookie | null>((r) => { resolve = r; });
  refreshLocks.set(siteId, { promise, resolve });

  const release = (value: StoredCfCookie | null) => {
    refreshLocks.delete(siteId);
    resolve(value);
  };

  return { locked: false, release };
}

/**
 * If another caller is refreshing the cookie for this site, wait for their result.
 */
export function waitForCfRefresh(siteId: number): Promise<StoredCfCookie | null> | null {
  const entry = refreshLocks.get(siteId);
  return entry?.promise ?? null;
}
