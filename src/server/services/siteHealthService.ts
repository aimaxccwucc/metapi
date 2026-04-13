import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { invalidateSiteProxyCache, withExplicitProxyRequestInit } from './siteProxy.js';
import { config } from '../config.js';
import { ensureCfCookie } from './cfChallengeBypass.js';

const SITE_HEALTH_TIMEOUT_MS = 6_000;
// Default to loose reachability: treat site as alive when web entry pages are reachable.
const SITE_HEALTH_PATHS = ['/', '/login'];
const SITE_HEALTH_CONCURRENCY = 8;

type SiteReachabilityProbeResult = {
  alive: boolean;
  reason: string;
  checkedUrl: string;
  statusCode: number | null;
};

export type SiteReachabilityRowResult = {
  siteId: number;
  siteName: string;
  siteUrl: string;
  accountCount: number;
  alive: boolean;
  reason: string;
  checkedUrl: string;
  statusCode: number | null;
  checkedAt: string;
};

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'unknown error';
}

function normalizeSiteBaseUrl(input: unknown): string {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

async function probeSiteReachability(baseUrl: string, proxyUrl?: string | null, siteId?: number): Promise<SiteReachabilityProbeResult> {
  const { fetch } = await import('undici');
  const normalizedBaseUrl = normalizeSiteBaseUrl(baseUrl);
  const errors: string[] = [];

  for (const path of SITE_HEALTH_PATHS) {
    const url = `${normalizedBaseUrl}${path}`;
    try {
      const requestInit = withExplicitProxyRequestInit(proxyUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(SITE_HEALTH_TIMEOUT_MS),
        headers: {
          Accept: 'application/json,text/plain,text/html,*/*',
        },
      });
      const response = await fetch(url, requestInit);
      // Any HTTP response means endpoint is reachable; keep cleanup conservative.
      // But for CF-protected sites, 403/503 with HTML body is a challenge, not real reachability.
      if ((response.status === 403 || response.status === 503) && siteId && (config.flaresolverrUrl)) {
        const contentType = response.headers.get('content-type') || '';
        const body = await response.text();
        if (contentType.includes('text/html') && (body.includes('Just a moment') || body.includes('challenge-platform'))) {
          // CF challenge detected — try to solve it and re-probe
          try {
            const cookie = await ensureCfCookie({ siteId, siteUrl: normalizedBaseUrl, proxyUrl: null, flaresolverrUrl: null });
            if (cookie) {
              const retryHeaders: Record<string, string> = {
                Accept: 'application/json,text/html,*/*',
                Cookie: `cf_clearance=${cookie.cfClearance}`,
                'User-Agent': cookie.userAgent || '',
              };
              const retryResp = await fetch(url, withExplicitProxyRequestInit(proxyUrl, {
                method: 'GET',
                signal: AbortSignal.timeout(SITE_HEALTH_TIMEOUT_MS),
                headers: retryHeaders,
              }));
              return {
                alive: true,
                reason: `HTTP ${retryResp.status} (CF bypass)`,
                checkedUrl: url,
                statusCode: retryResp.status,
              };
            }
          } catch {
            // CF bypass failed, return original 403/503 as reachable (conservative)
          }
          return {
            alive: true,
            reason: `HTTP ${response.status} (Cloudflare challenge)`,
            checkedUrl: url,
            statusCode: response.status,
          };
        }
        return {
          alive: true,
          reason: `HTTP ${response.status}`,
          checkedUrl: url,
          statusCode: response.status,
        };
      }
      return {
        alive: true,
        reason: `HTTP ${response.status}`,
        checkedUrl: url,
        statusCode: response.status,
      };
    } catch (error) {
      errors.push(`${path}: ${summarizeError(error)}`);
    }
  }

  return {
    alive: false,
    reason: errors[0] || 'unreachable',
    checkedUrl: `${normalizedBaseUrl}/`,
    statusCode: null,
  };
}

function toHealthStatus(alive: boolean): 'alive' | 'unreachable' {
  return alive ? 'alive' : 'unreachable';
}

function normalizeHealthReason(reason: string): string {
  const trimmed = String(reason || '').trim();
  if (!trimmed) return 'unreachable';
  return trimmed.slice(0, 500);
}

export async function executeRefreshSiteReachability() {
  const siteRows = await db.select().from(schema.sites).all();
  if (siteRows.length === 0) {
    return {
      summary: {
        total: 0,
        alive: 0,
        unreachable: 0,
        accountCountOnUnreachableSites: 0,
      },
      results: [] as SiteReachabilityRowResult[],
    };
  }

  const accountCountRows = await db.select({
    siteId: schema.accounts.siteId,
    count: sql<number>`count(*)`,
  }).from(schema.accounts).groupBy(schema.accounts.siteId).all();
  const accountCountBySiteId = new Map<number, number>();
  for (const row of accountCountRows) {
    accountCountBySiteId.set(row.siteId, Number(row.count || 0));
  }

  const results: SiteReachabilityRowResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(SITE_HEALTH_CONCURRENCY, siteRows.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= siteRows.length) break;
      const site = siteRows[idx];
      const checkedAt = new Date().toISOString();
      const probe = await probeSiteReachability(site.url, site.proxyUrl);
      results.push({
        siteId: site.id,
        siteName: site.name,
        siteUrl: site.url,
        accountCount: accountCountBySiteId.get(site.id) || 0,
        alive: probe.alive,
        reason: probe.reason,
        checkedUrl: probe.checkedUrl,
        statusCode: probe.statusCode,
        checkedAt,
      });
    }
  });
  await Promise.all(workers);

  await db.transaction(async (tx) => {
    for (const item of results) {
      await tx.update(schema.sites)
        .set({
          healthStatus: toHealthStatus(item.alive),
          healthReason: normalizeHealthReason(item.reason),
          healthCheckedAt: item.checkedAt,
          updatedAt: item.checkedAt,
        })
        .where(eq(schema.sites.id, item.siteId))
        .run();
    }
  });

  results.sort((a, b) => a.siteId - b.siteId);
  const summary = {
    total: results.length,
    alive: results.filter((item) => item.alive).length,
    unreachable: results.filter((item) => !item.alive).length,
    accountCountOnUnreachableSites: results
      .filter((item) => !item.alive)
      .reduce((sum, item) => sum + item.accountCount, 0),
  };
  return { summary, results };
}

export async function executeCleanupUnreachableSites(dryRun = false) {
  const refresh = await executeRefreshSiteReachability();
  const unreachableSites = refresh.results.filter((item) => !item.alive);
  const removedSiteIds: number[] = [];

  if (!dryRun && unreachableSites.length > 0) {
    await db.transaction(async (tx) => {
      for (const item of unreachableSites) {
        await tx.delete(schema.sites).where(eq(schema.sites.id, item.siteId)).run();
        removedSiteIds.push(item.siteId);
      }
    });
    invalidateSiteProxyCache();
  }

  const summary = {
    checkedSites: refresh.summary.total,
    unreachableSites: unreachableSites.length,
    removedSites: dryRun ? 0 : removedSiteIds.length,
    removedAccounts: dryRun
      ? 0
      : unreachableSites.reduce((sum, item) => sum + item.accountCount, 0),
    dryRun,
  };

  return {
    summary,
    unreachableSites,
    removedSiteIds,
  };
}
