import { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { checkinAccount, checkinAll } from '../../services/checkinService.js';
import { updateCheckinSchedule } from '../../services/checkinScheduler.js';
import { startBackgroundTask, summarizeCheckinResults } from '../../services/backgroundTaskService.js';
import { classifyFailureReason } from '../../services/failureReasonService.js';
import { formatUtcSqlDateTime, getLocalDayRangeUtc } from '../../services/localTimeService.js';

function buildCheckinAccountLabel(item: any): string {
  const username = item?.username || (item?.accountId ? `#${item.accountId}` : 'unknown');
  const site = item?.site || 'unknown-site';
  return `${username} @ ${site}`;
}

function buildCheckinReason(item: any): string {
  const message = String(item?.result?.message || '').trim();
  if (!message) return '';
  if (message.length <= 32) return message;
  return `${message.slice(0, 32)}...`;
}

function buildCheckinTaskDetailMessage(results: any[]): string {
  if (!Array.isArray(results) || results.length === 0) return '';

  const successRows = results.filter((item) => {
    const status = item?.result?.status;
    if (status === 'skipped' || item?.result?.skipped) return false;
    return !!item?.result?.success;
  });
  const skippedRows = results.filter((item) => {
    const status = item?.result?.status;
    return status === 'skipped' || !!item?.result?.skipped;
  });
  const failedRows = results.filter((item) => {
    const status = item?.result?.status;
    if (status === 'skipped' || item?.result?.skipped) return false;
    return !item?.result?.success;
  });

  const renderRows = (rows: any[], withReason = false) => {
    const sliced = rows.slice(0, 12).map((item) => {
      const base = buildCheckinAccountLabel(item);
      if (!withReason) return base;
      const reason = buildCheckinReason(item);
      return reason ? `${base}(${reason})` : base;
    });
    if (rows.length > 12) sliced.push(`...等${rows.length}个`);
    return sliced.join('、');
  };

  const segments: string[] = [
    `成功(${successRows.length}): ${successRows.length > 0 ? renderRows(successRows) : '-'}`,
    `跳过(${skippedRows.length}): ${skippedRows.length > 0 ? renderRows(skippedRows, true) : '-'}`,
    `失败(${failedRows.length}): ${failedRows.length > 0 ? renderRows(failedRows, true) : '-'}`,
  ];
  return segments.join('\n');
}

function normalizeCheckinLogTimeBoundary(raw: string | undefined, boundary: 'from' | 'to'): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const normalizedText = text.includes(' ') ? text.replace(' ', 'T') : text;
  const parsed = new Date(normalizedText);
  if (Number.isNaN(parsed.getTime())) return null;

  if (boundary === 'to' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(text)) {
    return formatUtcSqlDateTime(new Date(parsed.getTime() + 60_000));
  }

  return formatUtcSqlDateTime(parsed);
}

export async function checkinRoutes(app: FastifyInstance) {
  // Trigger check-in for all accounts
  app.post('/api/checkin/trigger', async (_, reply) => {
    const { task, reused } = startBackgroundTask(
      {
        type: 'checkin',
        title: '全部账号签到',
        dedupeKey: 'checkin-all',
        notifyOnFailure: true,
        successTitle: (currentTask) => {
          const summary = (currentTask.result as any)?.summary;
          if (!summary) return '全部账号签到已完成';
          return `全部账号签到已完成（成功${summary.success}/跳过${summary.skipped}/失败${summary.failed}）`;
        },
        failureTitle: () => '全部账号签到失败',
        successMessage: (currentTask) => {
          const summary = (currentTask.result as any)?.summary;
          const results = (currentTask.result as any)?.results;
          if (!summary) return '全部账号签到任务已完成';
          const detail = buildCheckinTaskDetailMessage(Array.isArray(results) ? results : []);
          return detail
            ? `全部账号签到完成：成功 ${summary.success}，跳过 ${summary.skipped}，失败 ${summary.failed}\n${detail}`
            : `全部账号签到完成：成功 ${summary.success}，跳过 ${summary.skipped}，失败 ${summary.failed}`;
        },
        failureMessage: (currentTask) => `全部账号签到任务失败：${currentTask.error || 'unknown error'}`,
      },
      async () => {
        const results = await checkinAll({ scheduleMode: config.checkinScheduleMode });
        return {
          summary: summarizeCheckinResults(results),
          total: results.length,
          results,
        };
      },
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '签到任务执行中，请稍后查看签到日志'
        : '已开始全部签到，请稍后查看签到日志',
    });
  });

  // Trigger check-in for a specific account
  app.post<{ Params: { id: string } }>('/api/checkin/trigger/:id', async (request) => {
    const id = parseInt(request.params.id, 10);
    const result = await checkinAccount(id, { scheduleMode: config.checkinScheduleMode });
    return result;
  });

  // Get check-in logs
  app.get<{ Querystring: { limit?: string; offset?: string; accountId?: string; from?: string; to?: string } }>('/api/checkin/logs', async (request, reply) => {
    const limit = parseInt(request.query.limit || '50', 10);
    const offset = parseInt(request.query.offset || '0', 10);
    const hasFrom = typeof request.query.from === 'string' && request.query.from.trim() !== '';
    const hasTo = typeof request.query.to === 'string' && request.query.to.trim() !== '';
    const defaultDayRange = !hasFrom && !hasTo ? getLocalDayRangeUtc(new Date()) : null;
    const fromUtc = hasFrom
      ? normalizeCheckinLogTimeBoundary(request.query.from, 'from')
      : (defaultDayRange?.startUtc ?? null);
    const toUtc = hasTo
      ? normalizeCheckinLogTimeBoundary(request.query.to, 'to')
      : (defaultDayRange?.endUtc ?? null);

    if (hasFrom && !fromUtc) {
      return reply.code(400).send({ error: '无效的开始时间' });
    }
    if (hasTo && !toUtc) {
      return reply.code(400).send({ error: '无效的结束时间' });
    }
    if (fromUtc && toUtc && fromUtc >= toUtc) {
      return reply.code(400).send({ error: '结束时间必须晚于开始时间' });
    }

    const whereClauses: any[] = [];
    if (request.query.accountId) {
      whereClauses.push(eq(schema.checkinLogs.accountId, parseInt(request.query.accountId, 10)));
    }
    if (fromUtc) {
      whereClauses.push(gte(schema.checkinLogs.createdAt, fromUtc));
    }
    if (toUtc) {
      whereClauses.push(lt(schema.checkinLogs.createdAt, toUtc));
    }

    let query = db.select().from(schema.checkinLogs)
      .innerJoin(schema.accounts, eq(schema.checkinLogs.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .orderBy(desc(schema.checkinLogs.createdAt))
      .limit(limit)
      .offset(offset);

    const whereClause = whereClauses.length === 0
      ? null
      : (whereClauses.length === 1 ? whereClauses[0] : and(...whereClauses));
    if (whereClause) {
      query = query.where(whereClause) as any;
    }

    const rows = await query.all();
    return rows.map((row: any) => {
      const source = row?.checkin_logs || row;
      const failureReason = classifyFailureReason({
        message: source?.message,
        status: source?.status,
      });
      return {
        ...row,
        failureReason,
      };
    });
  });

  // Update check-in schedule
  app.put<{ Body: { mode?: 'cron' | 'interval'; cron?: string; intervalHours?: number } }>('/api/checkin/schedule', async (request) => {
    try {
      const body = request.body || {};
      const nextMode: 'cron' | 'interval' = body.mode === 'interval' ? 'interval' : 'cron';
      const nextCron = typeof body.cron === 'string' ? body.cron : undefined;
      const nextIntervalHours = body.intervalHours !== undefined ? Number(body.intervalHours) : undefined;
      const normalizedIntervalHours = typeof nextIntervalHours === 'number' && Number.isFinite(nextIntervalHours)
        ? Math.trunc(nextIntervalHours)
        : undefined;

      updateCheckinSchedule({
        mode: nextMode,
        cronExpr: nextCron,
        intervalHours: normalizedIntervalHours,
      });

      await upsertSetting('checkin_schedule_mode', nextMode);
      if (nextCron !== undefined) await upsertSetting('checkin_cron', nextCron);
      if (normalizedIntervalHours !== undefined) {
        await upsertSetting('checkin_interval_hours', normalizedIntervalHours);
      }
      return {
        success: true,
        mode: nextMode,
        cron: nextCron,
        intervalHours: normalizedIntervalHours,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  });
}
