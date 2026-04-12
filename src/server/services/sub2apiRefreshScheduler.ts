import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getSub2ApiAuthFromExtraConfig } from './accountExtraConfig.js';
import {
  isManagedSub2ApiTokenDue,
  isSub2ApiPlatform,
} from './sub2apiManagedAuth.js';
import { refreshSub2ApiManagedSessionSingleflight } from './sub2apiRefreshSingleflight.js';

const ACTIVE_STATUS = 'active';
const SUB2API_PLATFORM = 'sub2api';
const SUB2API_REFRESH_SCHEDULER_INTERVAL_MS = 60_000;
export const SUB2API_REFRESH_SCHEDULER_CONCURRENCY = 4;

// Exponential backoff delays per consecutive failure: 2m, 5m, 15m, 1h, 6h
const REFRESH_BACKOFF_DELAYS_MS = [
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
];

type RefreshFailureRecord = {
  count: number;
  nextRetryAt: number;
};

const accountRefreshFailureMap = new Map<number, RefreshFailureRecord>();

function getRefreshBackoffDelayMs(failureCount: number): number {
  const idx = Math.min(failureCount - 1, REFRESH_BACKOFF_DELAYS_MS.length - 1);
  return REFRESH_BACKOFF_DELAYS_MS[Math.max(0, idx)];
}

function isAccountRefreshInBackoff(accountId: number, nowMs: number): boolean {
  const record = accountRefreshFailureMap.get(accountId);
  if (!record) return false;
  return nowMs < record.nextRetryAt;
}

function recordAccountRefreshFailure(accountId: number, nowMs: number): void {
  const existing = accountRefreshFailureMap.get(accountId);
  const count = (existing?.count ?? 0) + 1;
  accountRefreshFailureMap.set(accountId, {
    count,
    nextRetryAt: nowMs + getRefreshBackoffDelayMs(count),
  });
}

function clearAccountRefreshFailure(accountId: number): void {
  accountRefreshFailureMap.delete(accountId);
}

let sub2ApiRefreshSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let sub2ApiRefreshPassInFlight: Promise<void> | null = null;

function clearSub2ApiRefreshSchedulerTimer(): void {
  if (!sub2ApiRefreshSchedulerTimer) return;
  clearInterval(sub2ApiRefreshSchedulerTimer);
  sub2ApiRefreshSchedulerTimer = null;
}

function normalizeLifecycleStatus(value?: string | null): string {
  if (typeof value !== 'string') return ACTIVE_STATUS;
  const normalized = value.trim().toLowerCase();
  return normalized || ACTIVE_STATUS;
}

function normalizedLifecycleStatusSql(column: typeof schema.accounts.status | typeof schema.sites.status) {
  return sql<string>`coalesce(nullif(lower(trim(${column})), ''), ${ACTIVE_STATUS})`;
}

function normalizedPlatformSql(column: typeof schema.sites.platform) {
  return sql<string>`coalesce(lower(trim(${column})), '')`;
}

function shouldRefreshManagedSub2ApiAccount(input: {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  nowMs: number;
}): boolean {
  if (!isSub2ApiPlatform(input.site.platform)) return false;
  if (normalizeLifecycleStatus(input.account.status) !== ACTIVE_STATUS) return false;
  if (normalizeLifecycleStatus(input.site.status) !== ACTIVE_STATUS) return false;

  const managedAuth = getSub2ApiAuthFromExtraConfig(input.account.extraConfig);
  if (!managedAuth?.refreshToken || !managedAuth.tokenExpiresAt) return false;

  return isManagedSub2ApiTokenDue(managedAuth.tokenExpiresAt, input.nowMs);
}

export async function executeSub2ApiManagedRefreshPass(input: {
  nowMs?: number;
} = {}) {
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
    ? input.nowMs
    : Date.now();
  const rows = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      sql`${normalizedLifecycleStatusSql(schema.accounts.status)} = ${ACTIVE_STATUS}`,
      sql`${normalizedLifecycleStatusSql(schema.sites.status)} = ${ACTIVE_STATUS}`,
      sql`${normalizedPlatformSql(schema.sites.platform)} = ${SUB2API_PLATFORM}`,
    ))
    .all();

  const refreshCandidates = rows.filter((row: (typeof rows)[number]) =>
    shouldRefreshManagedSub2ApiAccount({ account: row.accounts, site: row.sites, nowMs }) &&
    !isAccountRefreshInBackoff(row.accounts.id, nowMs),
  );
  const refreshedAccountIds: number[] = [];
  const failedAccountIds: number[] = [];
  const skipped = rows.length - refreshCandidates.length;

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(SUB2API_REFRESH_SCHEDULER_CONCURRENCY, refreshCandidates.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const row = refreshCandidates[cursor];
      cursor += 1;
      if (!row) return;

      try {
        await refreshSub2ApiManagedSessionSingleflight({
          account: row.accounts,
          site: row.sites,
          currentAccessToken: row.accounts.accessToken || '',
          currentExtraConfig: row.accounts.extraConfig,
        });
        clearAccountRefreshFailure(row.accounts.id);
        refreshedAccountIds.push(row.accounts.id);
      } catch (error) {
        recordAccountRefreshFailure(row.accounts.id, nowMs);
        failedAccountIds.push(row.accounts.id);
        const record = accountRefreshFailureMap.get(row.accounts.id);
        const backoffMin = record ? Math.round((record.nextRetryAt - nowMs) / 60000) : 0;
        console.warn(
          `[sub2api-refresh] failed to refresh account ${row.accounts.id}: ${(error as Error)?.message || 'unknown error'} (backoff ${backoffMin}m, attempt #${record?.count ?? 1})`,
        );
      }
    }
  }));

  return {
    scanned: rows.length,
    refreshed: refreshedAccountIds.length,
    failed: failedAccountIds.length,
    skipped,
    refreshedAccountIds,
    failedAccountIds,
  };
}

async function runScheduledSub2ApiRefreshPass(): Promise<void> {
  if (sub2ApiRefreshPassInFlight) {
    return sub2ApiRefreshPassInFlight;
  }

  sub2ApiRefreshPassInFlight = executeSub2ApiManagedRefreshPass()
    .then(() => undefined)
    .catch((error) => {
      console.warn(`[sub2api-refresh] scheduled pass failed: ${(error as Error)?.message || 'unknown error'}`);
    })
    .finally(() => {
      sub2ApiRefreshPassInFlight = null;
    });

  return sub2ApiRefreshPassInFlight;
}

export function startSub2ApiManagedRefreshScheduler(intervalMs = SUB2API_REFRESH_SCHEDULER_INTERVAL_MS) {
  clearSub2ApiRefreshSchedulerTimer();

  const safeIntervalMs = Math.max(SUB2API_REFRESH_SCHEDULER_INTERVAL_MS, Math.trunc(intervalMs || 0));
  void runScheduledSub2ApiRefreshPass();
  sub2ApiRefreshSchedulerTimer = setInterval(() => {
    void runScheduledSub2ApiRefreshPass();
  }, safeIntervalMs);
  sub2ApiRefreshSchedulerTimer.unref?.();

  return {
    enabled: true,
    intervalMs: safeIntervalMs,
  };
}

export async function stopSub2ApiManagedRefreshScheduler() {
  clearSub2ApiRefreshSchedulerTimer();
  if (sub2ApiRefreshPassInFlight) {
    await sub2ApiRefreshPassInFlight;
  }
}

export async function __resetSub2ApiManagedRefreshSchedulerForTests() {
  await stopSub2ApiManagedRefreshScheduler();
  sub2ApiRefreshPassInFlight = null;
  accountRefreshFailureMap.clear();
}
