import { lt } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let retentionTimer: ReturnType<typeof setInterval> | null = null;

export function getProxyLogRetentionCutoffUtc(nowMs = Date.now()): string | null {
  const days = Math.max(0, Math.trunc(config.proxyLogRetentionDays));
  if (days <= 0) return null;
  return formatUtcSqlDateTime(new Date(nowMs - days * DAY_MS));
}

export async function cleanupExpiredProxyLogs(nowMs = Date.now()): Promise<{
  enabled: boolean;
  retentionDays: number;
  cutoffUtc: string | null;
  deleted: number;
}> {
  const retentionDays = Math.max(0, Math.trunc(config.proxyLogRetentionDays));
  const cutoffUtc = getProxyLogRetentionCutoffUtc(nowMs);
  if (!cutoffUtc) {
    return {
      enabled: false,
      retentionDays,
      cutoffUtc: null,
      deleted: 0,
    };
  }

  const deleted = (await db.delete(schema.proxyLogs)
    .where(lt(schema.proxyLogs.createdAt, cutoffUtc))
    .run())
    .changes;

  return {
    enabled: true,
    retentionDays,
    cutoffUtc,
    deleted,
  };
}

export function startProxyLogRetentionService(): void {
  if (retentionTimer) return;

  const intervalMinutes = Math.max(1, Math.trunc(config.proxyLogRetentionPruneIntervalMinutes));
  const intervalMs = intervalMinutes * 60 * 1000;
  const runCleanup = async () => {
    try {
      const result = await cleanupExpiredProxyLogs();
      if (!result.enabled || result.deleted <= 0) return;
      console.info(`[proxy-log-retention] deleted ${result.deleted} logs before ${result.cutoffUtc}`);
    } catch (error) {
      console.warn('[proxy-log-retention] cleanup failed', error);
    }
  };

  void runCleanup();
  retentionTimer = setInterval(() => { void runCleanup(); }, intervalMs);
  retentionTimer.unref?.();
}

export function stopProxyLogRetentionService(): void {
  if (!retentionTimer) return;
  clearInterval(retentionTimer);
  retentionTimer = null;
}
