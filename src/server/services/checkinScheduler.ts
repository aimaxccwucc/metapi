import cron from 'node-cron';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { refreshAllBalances } from './balanceService.js';
import { checkinAccount, checkinAll } from './checkinService.js';
import { refreshModelsAndRebuildRoutes } from './modelService.js';
import { sendNotification } from './notifyService.js';
import { buildDailySummaryNotification, collectDailySummaryMetrics } from './dailySummaryService.js';
import {
  getRunningTaskByDedupeKey,
  startBackgroundTask,
  summarizeCheckinResults,
} from './backgroundTaskService.js';
import { formatLocalDate } from './localTimeService.js';
import { executeRefreshSiteReachability } from './siteHealthService.js';

let checkinTask: cron.ScheduledTask | null = null;
let checkinRetryTask: cron.ScheduledTask | null = null;
let balanceTask: cron.ScheduledTask | null = null;
let dailySummaryTask: cron.ScheduledTask | null = null;
let siteHealthTask: cron.ScheduledTask | null = null;
let siteHealthRefreshRunning = false;

const DAILY_SUMMARY_DEFAULT_CRON = '58 23 * * *';
const CHECKIN_RETRY_DEFAULT_CRON = '30 9,12,15,18,21 * * *';
const CHECKIN_RETRY_STATE_KEY = 'checkin_retry_state';
const CHECKIN_RETRY_MAX_ATTEMPTS = 3;

type CheckinRetryState = {
  day: string;
  failedAccountIds: number[];
  retryAttempts: number;
  updatedAt: string;
};

async function resolveCronSetting(settingKey: string, fallback: string): Promise<string> {
  try {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, settingKey)).get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (typeof parsed === 'string' && cron.validate(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return fallback;
}

function createCheckinTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Running check-in at ${new Date().toISOString()}`);
    try {
      if (getRunningTaskByDedupeKey('checkin-all')) {
        console.log('[Scheduler] Check-in skipped: existing check-in task is running');
        return;
      }
      const today = formatLocalDate(new Date());
      const { reused } = startBackgroundTask(
        {
          type: 'checkin',
          title: `每日签到主任务 (${today})`,
          dedupeKey: 'checkin-all',
          notifyOnFailure: true,
          successTitle: (currentTask) => {
            const summary = (currentTask.result as any)?.summary;
            if (!summary) return `每日签到主任务 (${today}) 已完成`;
            return `每日签到主任务 (${today}) 已完成（成功${summary.success}/跳过${summary.skipped}/失败${summary.failed}）`;
          },
          failureTitle: () => `每日签到主任务 (${today}) 失败`,
          successMessage: (currentTask) => {
            const payload = (currentTask.result as any) || {};
            const summary = payload.summary;
            if (!summary) return `每日签到主任务 (${today}) 已完成`;
            return `每日签到主任务完成：成功 ${summary.success}，跳过 ${summary.skipped}，失败 ${summary.failed}`;
          },
          failureMessage: (currentTask) => `每日签到主任务失败：${currentTask.error || 'unknown error'}`,
        },
        async () => {
          const results = await checkinAll();
          const summary = summarizeCheckinResults(results);
          const failedAccountIds = results
            .filter((item) => {
              const status = item?.result?.status;
              if (status === 'skipped' || item?.result?.skipped) return false;
              return !item?.result?.success;
            })
            .map((item) => item.accountId);
          persistCheckinRetryState({
            day: today,
            failedAccountIds,
            retryAttempts: 0,
            updatedAt: new Date().toISOString(),
          });
          return { summary, total: results.length, failedAccountIds, results };
        },
      );
      console.log(
        reused
          ? '[Scheduler] Check-in reused running task'
          : '[Scheduler] Check-in main task queued',
      );
    } catch (err) {
      console.error('[Scheduler] Check-in error:', err);
    }
  });
}

function normalizeRetryState(raw: unknown): CheckinRetryState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const day = typeof record.day === 'string' ? record.day.trim() : '';
  if (!day) return null;
  const failedAccountIds = Array.isArray(record.failedAccountIds)
    ? record.failedAccountIds
      .map((item) => Number.parseInt(String(item), 10))
      .filter((item) => Number.isFinite(item) && item > 0)
    : [];
  const retryAttempts = Number.parseInt(String(record.retryAttempts ?? 0), 10);
  return {
    day,
    failedAccountIds: Array.from(new Set(failedAccountIds)),
    retryAttempts: Number.isFinite(retryAttempts) && retryAttempts >= 0 ? retryAttempts : 0,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt.trim()
      ? record.updatedAt.trim()
      : new Date().toISOString(),
  };
}

function readCheckinRetryState(): CheckinRetryState | null {
  try {
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, CHECKIN_RETRY_STATE_KEY)).get();
    if (!row?.value) return null;
    return normalizeRetryState(JSON.parse(row.value));
  } catch {
    return null;
  }
}

function persistCheckinRetryState(state: CheckinRetryState) {
  db.insert(schema.settings)
    .values({ key: CHECKIN_RETRY_STATE_KEY, value: JSON.stringify(state) })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: JSON.stringify(state) },
    })
    .run();
}

function clearCheckinRetryState() {
  db.delete(schema.settings).where(eq(schema.settings.key, CHECKIN_RETRY_STATE_KEY)).run();
}

function createCheckinRetryTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    const now = new Date();
    const today = formatLocalDate(now);
    const retryState = readCheckinRetryState();

    if (!retryState || retryState.day !== today || retryState.failedAccountIds.length === 0) {
      return;
    }

    if (retryState.retryAttempts >= CHECKIN_RETRY_MAX_ATTEMPTS) {
      console.log(`[Scheduler] Check-in retry skipped: reached max attempts (${CHECKIN_RETRY_MAX_ATTEMPTS})`);
      clearCheckinRetryState();
      return;
    }

    if (getRunningTaskByDedupeKey('checkin-all')) {
      console.log('[Scheduler] Check-in retry skipped: existing check-in task is running');
      return;
    }

    const attempt = retryState.retryAttempts + 1;
    const taskLabel = `签到失败账号重试（第${attempt}/${CHECKIN_RETRY_MAX_ATTEMPTS}轮）`;
    try {
      const { reused } = startBackgroundTask(
        {
          type: 'checkin',
          title: taskLabel,
          dedupeKey: `checkin-retry:${today}`,
          notifyOnFailure: true,
          successTitle: (currentTask) => {
            const summary = (currentTask.result as any)?.summary;
            if (!summary) return `${taskLabel} 已完成`;
            return `${taskLabel} 已完成（成功${summary.success}/跳过${summary.skipped}/失败${summary.failed}）`;
          },
          failureTitle: () => `${taskLabel} 失败`,
          successMessage: (currentTask) => {
            const payload = (currentTask.result as any) || {};
            const summary = payload.summary;
            const remaining = Array.isArray(payload.remainingFailedAccountIds)
              ? payload.remainingFailedAccountIds.length
              : 0;
            if (!summary) return `${taskLabel} 已完成`;
            return `${taskLabel}完成：成功 ${summary.success}，跳过 ${summary.skipped}，失败 ${summary.failed}，剩余待重试 ${remaining}`;
          },
          failureMessage: (currentTask) => `${taskLabel}失败：${currentTask.error || 'unknown error'}`,
        },
        async () => {
          const latestState = readCheckinRetryState();
          if (!latestState || latestState.day !== today || latestState.failedAccountIds.length === 0) {
            return {
              summary: { total: 0, success: 0, skipped: 0, failed: 0 },
              total: 0,
              remainingFailedAccountIds: [],
              skipped: true,
            };
          }

          const retryResults: Array<{ accountId: number; username: null; site: string; result: any }> = [];
          for (const accountId of latestState.failedAccountIds) {
            const result = await checkinAccount(accountId, { skipEvent: true });
            retryResults.push({
              accountId,
              username: null,
              site: '',
              result,
            });
          }

          const summary = summarizeCheckinResults(retryResults);
          const remainingFailedAccountIds = retryResults
            .filter((item) => {
              const status = item?.result?.status;
              if (status === 'skipped' || item?.result?.skipped) return false;
              return !item?.result?.success;
            })
            .map((item) => item.accountId);

          if (remainingFailedAccountIds.length > 0 && attempt < CHECKIN_RETRY_MAX_ATTEMPTS) {
            persistCheckinRetryState({
              day: today,
              failedAccountIds: remainingFailedAccountIds,
              retryAttempts: attempt,
              updatedAt: new Date().toISOString(),
            });
          } else {
            clearCheckinRetryState();
          }

          return {
            summary,
            total: retryResults.length,
            attempt,
            remainingFailedAccountIds,
            results: retryResults,
          };
        },
      );

      console.log(
        reused
          ? `[Scheduler] ${taskLabel} reused running task`
          : `[Scheduler] ${taskLabel} queued`,
      );
    } catch (err) {
      console.error('[Scheduler] Check-in retry error:', err);
    }
  });
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

export async function startScheduler() {
  const activeCheckinCron = await resolveCronSetting('checkin_cron', config.checkinCron);
  const activeCheckinRetryCron = await resolveCronSetting('checkin_retry_cron', CHECKIN_RETRY_DEFAULT_CRON);
  const activeBalanceCron = await resolveCronSetting('balance_refresh_cron', config.balanceRefreshCron);
  const activeDailySummaryCron = await resolveCronSetting('daily_summary_cron', DAILY_SUMMARY_DEFAULT_CRON);
  const activeSiteHealthCron = await resolveCronSetting('site_health_refresh_cron', config.siteHealthRefreshCron);
  config.checkinCron = activeCheckinCron;
  config.balanceRefreshCron = activeBalanceCron;
  config.siteHealthRefreshCron = activeSiteHealthCron;

  checkinTask = createCheckinTask(activeCheckinCron);
  checkinRetryTask = createCheckinRetryTask(activeCheckinRetryCron);
  balanceTask = createBalanceTask(activeBalanceCron);
  dailySummaryTask = createDailySummaryTask(activeDailySummaryCron);
  siteHealthTask = createSiteHealthTask(activeSiteHealthCron);

  console.log(`[Scheduler] Check-in cron: ${activeCheckinCron}`);
  console.log(`[Scheduler] Check-in retry cron: ${activeCheckinRetryCron}`);
  console.log(`[Scheduler] Balance refresh cron: ${activeBalanceCron}`);
  console.log(`[Scheduler] Daily summary cron: ${activeDailySummaryCron}`);
  console.log(`[Scheduler] Site health refresh cron: ${activeSiteHealthCron}`);
}

export function updateCheckinCron(cronExpr: string) {
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);
  config.checkinCron = cronExpr;
  checkinTask?.stop();
  checkinTask = createCheckinTask(cronExpr);
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
