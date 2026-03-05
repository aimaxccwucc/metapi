import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { invalidateSiteProxyCache, withExplicitProxyRequestInit } from './siteProxy.js';

const SITE_HEALTH_TIMEOUT_MS = 6_000;
const SITE_HEALTH_PATHS = ['/api/status', '/v1/models', '/'];
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

async function probeSiteReachability(baseUrl: string, proxyUrl?: string | null): Promise<SiteReachabilityProbeResult> {
  const { fetch } = await import('undici');
  const normalizedBaseUrl = normalizeSiteBaseUrl(baseUrl);
  const errors: string[] = [];

  for (const path of SITE_HEALTH_PATHS) {
    const url = `${normalizedBaseUrl}${path}`;
    try {
      const response = await fetch(url, withExplicitProxyRequestInit(proxyUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(SITE_HEALTH_TIMEOUT_MS),
        headers: {
          Accept: 'application/json,text/plain,text/html,*/*',
        },
      }));
      // Any HTTP response means endpoint is reachable; keep cleanup conservative.
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
  const siteRows = db.select().from(schema.sites).all();
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

  const accountCountRows = db.select({
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

  db.transaction((tx) => {
    for (const item of results) {
      tx.update(schema.sites)
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
    db.transaction((tx) => {
      for (const item of unreachableSites) {
        tx.delete(schema.sites).where(eq(schema.sites.id, item.siteId)).run();
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
