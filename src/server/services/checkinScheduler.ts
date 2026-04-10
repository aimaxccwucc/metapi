import cron from 'node-cron';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { refreshAllBalances } from './balanceService.js';
import { checkinAll, isSchedulableCheckinAccountStatus } from './checkinService.js';
import { extractCheckinSnapshot } from './accountExtraConfig.js';
import { refreshModelsAndRebuildRoutes } from './modelService.js';
import { sendNotification } from './notifyService.js';
import { buildDailySummaryNotification, collectDailySummaryMetrics } from './dailySummaryService.js';
import { cleanupConfiguredLogs, normalizeLogCleanupRetentionDays } from './logCleanupService.js';
import { executeRefreshSiteReachability } from './siteHealthService.js';
import { pruneResponseCache } from './responseCacheService.js';
import {
  executeRoutingGovernanceAutoRecoveryPass,
  recordRoutingGovernanceAutoRecoveryEvent,
} from './routingGovernanceAutoRecoveryService.js';
import { reconcileHistoricalSharedGroupAutoTokens } from './tokenCoverageAutoProvisionService.js';

export type CheckinScheduleMode = 'cron' | 'interval';

let checkinTask: cron.ScheduledTask | null = null;
let checkinIntervalTimer: ReturnType<typeof setInterval> | null = null;
let balanceTask: cron.ScheduledTask | null = null;
let dailySummaryTask: cron.ScheduledTask | null = null;
let logCleanupTask: cron.ScheduledTask | null = null;
let siteHealthTask: cron.ScheduledTask | null = null;
let responseCacheCleanupTask: cron.ScheduledTask | null = null;
let routingGovernanceRecoveryTask: cron.ScheduledTask | null = null;
let tokenCoverageReconcileTask: cron.ScheduledTask | null = null;
let siteHealthRefreshRunning = false;
let routingGovernanceRecoveryRunning = false;
let tokenCoverageReconcileRunning = false;
const intervalAttemptByAccount = new Map<number, number>();
let intervalCheckinPassRunning = false;

const DAILY_SUMMARY_DEFAULT_CRON = '58 23 * * *';
const LOG_CLEANUP_DEFAULT_CRON = '0 6 * * *';
const CHECKIN_INTERVAL_POLL_MS = 60_000;
const ROUTING_GOVERNANCE_RECOVERY_DEFAULT_CRON = '*/10 * * * *';
const TOKEN_COVERAGE_RECONCILE_DEFAULT_CRON = '13 3 * * *';

async function resolveJsonSetting<T>(
  settingKey: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
): Promise<T> {
  try {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, settingKey)).get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (isValid(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return fallback;
}

async function resolveCronSetting(settingKey: string, fallback: string): Promise<string> {
  return resolveJsonSetting(settingKey, (value): value is string => typeof value === 'string' && cron.validate(value), fallback);
}

async function resolveBooleanSetting(settingKey: string, fallback: boolean): Promise<boolean> {
  return resolveJsonSetting(settingKey, (value): value is boolean => typeof value === 'boolean', fallback);
}

async function resolvePositiveIntegerSetting(settingKey: string, fallback: number): Promise<number> {
  return resolveJsonSetting(
    settingKey,
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1,
    fallback,
  );
}

function createCheckinTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Running check-in at ${new Date().toISOString()}`);
    try {
      const results = await checkinAll({ scheduleMode: 'cron' });
      const success = results.filter((r) => r.result.success).length;
      const failed = results.length - success;
      console.log(`[Scheduler] Check-in complete: ${success} success, ${failed} failed`);
    } catch (err) {
      console.error('[Scheduler] Check-in error:', err);
    }
  });
}

type IntervalCheckinCandidate = {
  id: number;
  lastCheckinAt?: string | null;
  extraConfig?: string | null;
};

type IntervalCheckinResult = {
  accountId: number;
  result?: {
    success?: boolean;
    status?: string;
    skipped?: boolean;
  };
};

export function selectDueIntervalCheckinAccountIds(
  rows: IntervalCheckinCandidate[],
  intervalHours: number,
  now = new Date(),
  attemptState = intervalAttemptByAccount,
) {
  const nowMs = now.getTime();
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

  return rows
    .filter((row) => {
      const snapshot = extractCheckinSnapshot(row.extraConfig);
      const nextRetryAtMs = snapshot?.nextRetryAt ? Date.parse(snapshot.nextRetryAt) : Number.NaN;
      if (snapshot?.status === 'manual_required' || snapshot?.status === 'unsupported' || snapshot?.status === 'site_disabled') {
        return false;
      }
      if (Number.isFinite(nextRetryAtMs) && nextRetryAtMs > nowMs) {
        return false;
      }
      const lastCheckinMs = row.lastCheckinAt ? Date.parse(row.lastCheckinAt) : Number.NaN;
      const persistedAttemptMs = snapshot?.lastIntervalAttemptAt ? Date.parse(snapshot.lastIntervalAttemptAt) : Number.NaN;
      const memoryAttemptMs = attemptState.get(row.id);
      const lastAttemptMs = Number.isFinite(persistedAttemptMs)
        ? persistedAttemptMs
        : memoryAttemptMs;
      if (Number.isFinite(lastCheckinMs)) {
        if (nowMs - lastCheckinMs < intervalMs) return false;
        if (typeof lastAttemptMs === 'number' && lastAttemptMs >= lastCheckinMs && nowMs - lastAttemptMs < intervalMs) {
          return false;
        }
        return true;
      }
      if (typeof lastAttemptMs === 'number' && nowMs - lastAttemptMs < intervalMs) return false;
      return true;
    })
    .map((row) => row.id);
}

async function runIntervalCheckinPass(now = new Date()) {
  if (intervalCheckinPassRunning) {
    console.log('[Scheduler] Interval check-in skipped: existing run is in progress');
    return;
  }
  intervalCheckinPassRunning = true;
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  try {
    const dueAccountIds = selectDueIntervalCheckinAccountIds(
      rows
        .filter((row: any) => (
          row.accounts?.checkinEnabled === true
          && isSchedulableCheckinAccountStatus(row.accounts?.status)
          && row.sites?.status !== 'disabled'
        ))
        .map((row: any) => ({
          id: row.accounts.id,
          lastCheckinAt: row.accounts.lastCheckinAt,
          extraConfig: row.accounts.extraConfig ?? null,
        })),
      config.checkinIntervalHours,
      now,
    );

    if (dueAccountIds.length === 0) return;

    const results = await checkinAll({
      accountIds: dueAccountIds,
      scheduleMode: 'interval',
    });
    const nowMs = now.getTime();
    applyIntervalCheckinAttemptResults(results, nowMs);
    const success = results.filter((r) => r.result.success).length;
    const failed = results.length - success;
    console.log(`[Scheduler] Interval check-in complete: ${success} success, ${failed} failed`);
  } catch (err) {
    console.error('[Scheduler] Interval check-in error:', err);
  } finally {
    intervalCheckinPassRunning = false;
  }
}

function shouldRecordIntervalAttemptResult(item: IntervalCheckinResult): boolean {
  if (!item?.result) return false;
  if (item.result.success === true) return true;
  if (item.result.status === 'skipped' || item.result.skipped === true) return true;
  return false;
}

function applyIntervalCheckinAttemptResults(results: IntervalCheckinResult[], nowMs: number, attemptState = intervalAttemptByAccount): void {
  for (const item of results) {
    if (!Number.isFinite(item?.accountId) || item.accountId <= 0) continue;
    if (!shouldRecordIntervalAttemptResult(item)) continue;
    attemptState.set(item.accountId, nowMs);
  }
}

function stopCheckinSchedule() {
  checkinTask?.stop();
  checkinTask = null;
  if (checkinIntervalTimer) {
    clearInterval(checkinIntervalTimer);
    checkinIntervalTimer = null;
  }
}

function startCheckinSchedule() {
  stopCheckinSchedule();
  if (config.checkinScheduleMode === 'interval') {
    checkinIntervalTimer = setInterval(() => {
      void runIntervalCheckinPass();
    }, CHECKIN_INTERVAL_POLL_MS);
    return;
  }
  checkinTask = createCheckinTask(config.checkinCron);
}

function createBalanceTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Refreshing balances at ${new Date().toISOString()}`);
    try {
      await refreshAllBalances();
      await refreshModelsAndRebuildRoutes();
      console.log('[Scheduler] Balance refresh complete');
    } catch (err) {
      console.error('[Scheduler] Balance refresh error:', err);
    }
  });
}

function createDailySummaryTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Sending daily summary at ${new Date().toISOString()}`);
    try {
      const metrics = await collectDailySummaryMetrics();
      const { title, message } = buildDailySummaryNotification(metrics);
      await sendNotification(title, message, 'info', {
        bypassThrottle: true,
        requireChannel: true,
        throwOnFailure: true,
      });
      console.log(`[Scheduler] Daily summary sent: ${title}`);
    } catch (err) {
      console.error('[Scheduler] Daily summary error:', err);
    }
  });
}

function createLogCleanupTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    if (!config.logCleanupConfigured) {
      console.log('[Scheduler] Log cleanup skipped: legacy fallback mode is active');
      return;
    }
    console.log(`[Scheduler] Running log cleanup at ${new Date().toISOString()}`);
    try {
      const result = await cleanupConfiguredLogs();
      if (!result.enabled) {
        console.log('[Scheduler] Log cleanup skipped: no log target enabled');
        return;
      }
      console.log(
        `[Scheduler] Log cleanup complete: usage=${result.usageLogsDeleted}, program=${result.programLogsDeleted}, cutoff=${result.cutoffUtc}`,
      );
    } catch (err) {
      console.error('[Scheduler] Log cleanup error:', err);
    }
  });
}

function createResponseCacheCleanupTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    try {
      await pruneResponseCache();
    } catch (err) {
      console.error('[Scheduler] Response cache cleanup error:', err);
    }
  });
}

function createSiteHealthTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    if (siteHealthRefreshRunning) {
      console.log('[Scheduler] Site health refresh skipped: existing run is in progress');
      return;
    }
    siteHealthRefreshRunning = true;
    try {
      const result = await executeRefreshSiteReachability();
      console.log(
        `[Scheduler] Site health refresh done: alive=${result.summary.alive}, unreachable=${result.summary.unreachable}`,
      );
    } catch (err) {
      console.error('[Scheduler] Site health refresh error:', err);
    } finally {
      siteHealthRefreshRunning = false;
    }
  });
}

function createRoutingGovernanceRecoveryTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    if (routingGovernanceRecoveryRunning) {
      console.log('[Scheduler] Routing governance recovery skipped: existing run is in progress');
      return;
    }
    routingGovernanceRecoveryRunning = true;
    try {
      const result = await executeRoutingGovernanceAutoRecoveryPass();
      if (result.scanned > 0 || result.promotedToProbing > 0 || result.restored > 0) {
        await recordRoutingGovernanceAutoRecoveryEvent(result);
      }
      console.log(
        `[Scheduler] Routing governance recovery pass done: scanned=${result.scanned}, promoted=${result.promotedToProbing}, keptSuppressed=${result.keptSuppressed}, restored=${result.restored}`,
      );
    } catch (err) {
      console.error('[Scheduler] Routing governance recovery error:', err);
    } finally {
      routingGovernanceRecoveryRunning = false;
    }
  });
}

function createTokenCoverageReconcileTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    if (tokenCoverageReconcileRunning) {
      console.log('[Scheduler] Token coverage reconcile skipped: existing run is in progress');
      return;
    }
    tokenCoverageReconcileRunning = true;
    try {
      const result = await reconcileHistoricalSharedGroupAutoTokens();
      console.log(
        `[Scheduler] Token coverage reconcile done: scanned=${result.accountsScanned}, explicit=${result.accountsWithExplicitTargets}, cleanupOnly=${result.accountsWithoutExplicitTargets}, created=${result.provisionSummary.created}, reused=${result.provisionSummary.reused}, failed=${result.provisionSummary.failed}`,
      );
    } catch (err) {
      console.error('[Scheduler] Token coverage reconcile error:', err);
    } finally {
      tokenCoverageReconcileRunning = false;
    }
  });
}

export async function startScheduler() {
  const activeCheckinCron = await resolveCronSetting('checkin_cron', config.checkinCron);
  const activeCheckinScheduleMode = await resolveJsonSetting<CheckinScheduleMode>(
    'checkin_schedule_mode',
    (value): value is CheckinScheduleMode => value === 'cron' || value === 'interval',
    config.checkinScheduleMode as CheckinScheduleMode,
  );
  const activeCheckinIntervalHours = await resolvePositiveIntegerSetting(
    'checkin_interval_hours',
    config.checkinIntervalHours,
  );
  const activeBalanceCron = await resolveCronSetting('balance_refresh_cron', config.balanceRefreshCron);
  const activeSiteHealthCron = await resolveCronSetting('site_health_refresh_cron', config.siteHealthRefreshCron);
  const activeDailySummaryCron = await resolveCronSetting('daily_summary_cron', DAILY_SUMMARY_DEFAULT_CRON);
  const activeLogCleanupCron = await resolveCronSetting('log_cleanup_cron', config.logCleanupCron || LOG_CLEANUP_DEFAULT_CRON);
  const activeLogCleanupUsageLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_usage_logs_enabled',
    config.logCleanupUsageLogsEnabled,
  );
  const activeLogCleanupProgramLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_program_logs_enabled',
    config.logCleanupProgramLogsEnabled,
  );
  const activeLogCleanupRetentionDays = await resolvePositiveIntegerSetting(
    'log_cleanup_retention_days',
    normalizeLogCleanupRetentionDays(config.logCleanupRetentionDays),
  );
  config.checkinCron = activeCheckinCron;
  config.checkinScheduleMode = activeCheckinScheduleMode;
  config.checkinIntervalHours = Math.min(24, Math.max(1, activeCheckinIntervalHours));
  config.balanceRefreshCron = activeBalanceCron;
  config.siteHealthRefreshCron = activeSiteHealthCron;
  config.logCleanupCron = activeLogCleanupCron;
  config.logCleanupUsageLogsEnabled = activeLogCleanupUsageLogsEnabled;
  config.logCleanupProgramLogsEnabled = activeLogCleanupProgramLogsEnabled;
  config.logCleanupRetentionDays = activeLogCleanupRetentionDays;

  stopCheckinSchedule();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  siteHealthTask?.stop();
  responseCacheCleanupTask?.stop();
  routingGovernanceRecoveryTask?.stop();
  tokenCoverageReconcileTask?.stop();
  startCheckinSchedule();
  balanceTask = createBalanceTask(activeBalanceCron);
  siteHealthTask = createSiteHealthTask(activeSiteHealthCron);
  dailySummaryTask = createDailySummaryTask(activeDailySummaryCron);
  logCleanupTask = createLogCleanupTask(activeLogCleanupCron);
  responseCacheCleanupTask = createResponseCacheCleanupTask('0 * * * *');
  routingGovernanceRecoveryTask = createRoutingGovernanceRecoveryTask(ROUTING_GOVERNANCE_RECOVERY_DEFAULT_CRON);
  tokenCoverageReconcileTask = createTokenCoverageReconcileTask(TOKEN_COVERAGE_RECONCILE_DEFAULT_CRON);

  console.log(`[Scheduler] Check-in schedule: ${config.checkinScheduleMode} (${config.checkinScheduleMode === 'cron' ? activeCheckinCron : `${config.checkinIntervalHours}h`})`);
  console.log(`[Scheduler] Balance refresh cron: ${activeBalanceCron}`);
  console.log(`[Scheduler] Site health refresh cron: ${activeSiteHealthCron}`);
  console.log(`[Scheduler] Daily summary cron: ${activeDailySummaryCron}`);
  console.log(`[Scheduler] Routing governance recovery cron: ${ROUTING_GOVERNANCE_RECOVERY_DEFAULT_CRON}`);
  console.log(`[Scheduler] Token coverage reconcile cron: ${TOKEN_COVERAGE_RECONCILE_DEFAULT_CRON}`);
  console.log(
    `[Scheduler] Log cleanup cron: ${activeLogCleanupCron} (configured=${config.logCleanupConfigured}, usage=${activeLogCleanupUsageLogsEnabled}, program=${activeLogCleanupProgramLogsEnabled}, retentionDays=${activeLogCleanupRetentionDays})`,
  );
}

export function updateCheckinCron(cronExpr: string) {
  updateCheckinSchedule({
    mode: 'cron',
    cronExpr,
    intervalHours: config.checkinIntervalHours,
  });
}

export function updateCheckinSchedule(input: {
  mode: CheckinScheduleMode;
  cronExpr?: string;
  intervalHours?: number;
}) {
  const nextMode = input.mode;
  if (nextMode !== 'cron' && nextMode !== 'interval') {
    throw new Error(`Invalid checkin schedule mode: ${String(nextMode)}`);
  }

  const nextCronExpr = input.cronExpr ?? config.checkinCron;
  if (!cron.validate(nextCronExpr)) throw new Error(`Invalid cron: ${nextCronExpr}`);

  const nextIntervalHours = input.intervalHours ?? config.checkinIntervalHours;
  if (!Number.isFinite(nextIntervalHours) || nextIntervalHours < 1 || nextIntervalHours > 24) {
    throw new Error(`Invalid interval hours: ${String(nextIntervalHours)}`);
  }

  config.checkinScheduleMode = nextMode;
  config.checkinCron = nextCronExpr;
  config.checkinIntervalHours = Math.trunc(nextIntervalHours);
  startCheckinSchedule();
}

export function updateBalanceRefreshCron(cronExpr: string) {
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);
  config.balanceRefreshCron = cronExpr;
  balanceTask?.stop();
  balanceTask = createBalanceTask(cronExpr);
}

export function updateSiteHealthRefreshCron(cronExpr: string) {
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);
  config.siteHealthRefreshCron = cronExpr;
  siteHealthTask?.stop();
  siteHealthTask = createSiteHealthTask(cronExpr);
}

export function updateLogCleanupSettings(input: {
  cronExpr?: string;
  usageLogsEnabled?: boolean;
  programLogsEnabled?: boolean;
  retentionDays?: number;
}) {
  const cronExpr = input.cronExpr ?? config.logCleanupCron;
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);

  const retentionDays = normalizeLogCleanupRetentionDays(input.retentionDays ?? config.logCleanupRetentionDays);

  config.logCleanupCron = cronExpr;
  if (input.usageLogsEnabled !== undefined) config.logCleanupUsageLogsEnabled = !!input.usageLogsEnabled;
  if (input.programLogsEnabled !== undefined) config.logCleanupProgramLogsEnabled = !!input.programLogsEnabled;
  config.logCleanupRetentionDays = retentionDays;

  logCleanupTask?.stop();
  logCleanupTask = createLogCleanupTask(cronExpr);
}

export function __resetCheckinSchedulerForTests() {
  stopCheckinSchedule();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  siteHealthTask?.stop();
  responseCacheCleanupTask?.stop();
  routingGovernanceRecoveryTask?.stop();
  tokenCoverageReconcileTask?.stop();
  balanceTask = null;
  dailySummaryTask = null;
  logCleanupTask = null;
  siteHealthTask = null;
  responseCacheCleanupTask = null;
  routingGovernanceRecoveryTask = null;
  tokenCoverageReconcileTask = null;
  siteHealthRefreshRunning = false;
  routingGovernanceRecoveryRunning = false;
  tokenCoverageReconcileRunning = false;
  intervalCheckinPassRunning = false;
  intervalAttemptByAccount.clear();
}
