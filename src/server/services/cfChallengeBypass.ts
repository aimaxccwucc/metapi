import { config } from '../config.js';
import {
  type StoredCfCookie,
  getCfCookie,
  setCfCookie,
  isCfCookieValid,
  isCfCookieNearExpiry,
  buildCfCookieEntry,
  withCfCookieOverride,
  getCfCookieOverride,
  acquireCfRefreshLock,
  waitForCfRefresh,
} from './cfChallengeCookieStore.js';
import { solveCfChallenge } from './flaresolverrClient.js';

const CF_CLEARANCE_COOKIE_NAME = 'cf_clearance';
const CF_BODY_MARKER = 'Just a moment';
const CF_BODY_MARKER_2 = 'challenge-platform';
const CF_BODY_MARKER_3 = 'cf-browser-verification';

export type CfBypassContext = {
  siteId: number;
  siteUrl: string;
  proxyUrl?: string | null;
  flaresolverrUrl?: string | null;
};

export function isCloudflareChallenge(status: number, body: string): boolean {
  if (status !== 403 && status !== 503) return false;
  return body.includes(CF_BODY_MARKER)
    || body.includes(CF_BODY_MARKER_2)
    || body.includes(CF_BODY_MARKER_3);
}

function resolveFlaresolverrUrl(ctx: CfBypassContext): string | null {
  if (ctx.flaresolverrUrl) return ctx.flaresolverrUrl;
  if (config.flaresolverrUrl) return config.flaresolverrUrl;
  return null;
}

async function refreshCfCookie(ctx: CfBypassContext): Promise<StoredCfCookie | null> {
  const fsUrl = resolveFlaresolverrUrl(ctx);
  if (!fsUrl) return null;

  // Check if another call is already refreshing for this site
  const pending = waitForCfRefresh(ctx.siteId);
  if (pending) {
    return pending;
  }

  const lock = acquireCfRefreshLock(ctx.siteId);
  if (lock.locked) {
    // Another caller won the race, wait for their result
    const pendingResult = waitForCfRefresh(ctx.siteId);
    return pendingResult ?? null;
  }

  try {
    // Probe a lightweight admin URL to trigger CF challenge and get cookie
    const probeUrl = `${ctx.siteUrl.replace(/\/+$/, '')}/api/user/self`;
    const result = await solveCfChallenge(fsUrl, probeUrl, {
      // Do NOT pass account proxy to FlareSolverr — it solves CF challenges
      // reliably without proxy, and adding a proxy often causes timeouts.
      // The cf_clearance cookie is bound to IP; FlareSolverr and metapi
      // share the same Docker network exit IP, so the cookie remains valid.
    });

    if (!result.success || !result.cookies[CF_CLEARANCE_COOKIE_NAME]) {
      lock.release(null);
      return null;
    }

    const entry = buildCfCookieEntry(
      result.cookies[CF_CLEARANCE_COOKIE_NAME],
      result.userAgent,
      'flaresolverr',
    );
    await setCfCookie(ctx.siteId, entry);
    lock.release(entry);
    return entry;
  } catch {
    lock.release(null);
    return null;
  }
}

/**
 * Execute a request function with CF bypass support.
 *
 * 1. Inject cached cf_clearance cookie if available
 * 2. If request returns CF challenge → refresh cookie via FlareSolverr → retry
 */
export async function withCfBypass<T>(
  ctx: CfBypassContext,
  requestFn: () => Promise<T>,
  detectCfChallenge: (result: T) => boolean,
): Promise<T> {
  const cachedCookie = await getCfCookie(ctx.siteId);

  // Build cookie override from cache
  const buildCookieOverride = (entry: StoredCfCookie | null): Record<string, string> | null => {
    if (!entry || !isCfCookieValid(entry)) return null;
    return { [CF_CLEARANCE_COOKIE_NAME]: entry.cfClearance };
  };

  // Attempt 1: with cached cookie (or no cookie)
  const cookieOverride = buildCookieOverride(cachedCookie);
  let result = await withCfCookieOverride(cookieOverride, requestFn);

  // Check if CF challenge was detected
  if (!detectCfChallenge(result)) {
    return result;
  }

  // CF challenge detected — try to refresh cookie
  const refreshed = await refreshCfCookie(ctx);
  if (!refreshed) {
    return result; // return original failure
  }

  // Attempt 2: with fresh cookie
  const freshOverride = buildCookieOverride(refreshed);
  return withCfCookieOverride(freshOverride, requestFn);
}

/**
 * Get stored CF cookie override for the current async context.
 * Used by adapter to inject cf_clearance into requests.
 */
export function getCurrentCfCookies(): Record<string, string> | null {
  const override = getCfCookieOverride();
  if (override) return override.cookies;

  // Fall back to persisted store (async, not ALS-scoped)
  // Callers should prefer withCfCookieOverride path for correctness
  return null;
}

/**
 * Proactively refresh CF cookie if near expiry (called before checkin).
 * Returns the current valid cookie, refreshing if needed.
 */
export async function ensureCfCookie(ctx: CfBypassContext): Promise<StoredCfCookie | null> {
  const cached = await getCfCookie(ctx.siteId);
  if (cached && isCfCookieValid(cached) && !isCfCookieNearExpiry(cached)) {
    return cached;
  }

  // Refresh proactively
  return refreshCfCookie(ctx);
}
