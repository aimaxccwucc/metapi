import { FastifyInstance } from 'fastify';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { repairAllAccountKeys } from '../../services/accountKeyRepairService.js';

function buildAccountKeyRepairTaskDetailMessage(results: Awaited<ReturnType<typeof repairAllAccountKeys>>['results']): string {
  if (!Array.isArray(results) || results.length === 0) return '';

  const renderRows = (rows: typeof results, withReason = false) => {
    const sliced = rows.slice(0, 12).map((item) => {
      const base = `${item.accountName || `#${item.accountId}`} @ ${item.siteName || 'unknown-site'}`;
      if (!withReason) return base;
      const reason = String(item.message || item.reason || '').trim();
      if (!reason) return base;
      return reason.length <= 32 ? `${base}(${reason})` : `${base}(${reason.slice(0, 32)}...)`;
    });
    if (rows.length > 12) sliced.push(`...等${rows.length}个`);
    return sliced.join('、');
  };

  const repairedRows = results.filter((item) => item.status === 'repaired' || item.status === 'created' || item.status === 'synced');
  const alreadyRows = results.filter((item) => item.status === 'already_ok');
  const skippedRows = results.filter((item) => item.status === 'skipped');
  const failedRows = results.filter((item) => item.status === 'failed');

  return [
    `修复(${repairedRows.length}): ${repairedRows.length > 0 ? renderRows(repairedRows) : '-'}`,
    `已正常(${alreadyRows.length}): ${alreadyRows.length > 0 ? renderRows(alreadyRows) : '-'}`,
    `跳过(${skippedRows.length}): ${skippedRows.length > 0 ? renderRows(skippedRows, true) : '-'}`,
    `失败(${failedRows.length}): ${failedRows.length > 0 ? renderRows(failedRows, true) : '-'}`,
  ].join('\n');
}

export async function registerAccountMaintenanceRoutes(app: FastifyInstance) {
  app.post<{ Body?: { wait?: boolean } }>('/api/accounts/keys/repair', async (request, reply) => {
    if (request.body?.wait) {
      const result = await repairAllAccountKeys();
      return { success: true, ...result };
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'token',
        title: '账号 Key 一键修复',
        dedupeKey: 'repair-all-account-keys',
        notifyOnFailure: true,
        successTitle: (currentTask) => {
          const summary = (currentTask.result as Awaited<ReturnType<typeof repairAllAccountKeys>> | null)?.summary;
          if (!summary) return '账号 Key 一键修复已完成';
          return `账号 Key 一键修复已完成（修复${summary.repaired + summary.created + summary.synced}/失败${summary.failed}/跳过${summary.skipped}）`;
        },
        failureTitle: () => '账号 Key 一键修复失败',
        successMessage: (currentTask) => {
          const payload = (currentTask.result as Awaited<ReturnType<typeof repairAllAccountKeys>> | null);
          if (!payload?.summary) return '账号 Key 一键修复任务已完成';
          const detail = buildAccountKeyRepairTaskDetailMessage(payload.results || []);
          return detail
            ? `账号 Key 一键修复完成：修复 ${payload.summary.repaired + payload.summary.created + payload.summary.synced}，已正常 ${payload.summary.alreadyOk}，跳过 ${payload.summary.skipped}，失败 ${payload.summary.failed}\n${detail}`
            : `账号 Key 一键修复完成：修复 ${payload.summary.repaired + payload.summary.created + payload.summary.synced}，已正常 ${payload.summary.alreadyOk}，跳过 ${payload.summary.skipped}，失败 ${payload.summary.failed}`;
        },
        failureMessage: (currentTask) => `账号 Key 一键修复失败：${currentTask.error || 'unknown error'}`,
      },
      async () => repairAllAccountKeys(),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '账号 Key 修复任务执行中，请稍后查看任务中心'
        : '已开始账号 Key 一键修复，请稍后查看任务中心',
    });
  });
}
