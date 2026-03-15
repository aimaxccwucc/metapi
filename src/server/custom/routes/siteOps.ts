import { FastifyInstance } from 'fastify';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { executeCleanupUnreachableSites, executeRefreshSiteReachability } from '../../services/siteHealthService.js';

export async function registerSiteOpsRoutes(app: FastifyInstance) {
  app.post<{ Body?: { wait?: boolean } }>('/api/sites/health/refresh', async (request) => {
    if (request.body?.wait) {
      const result = await executeRefreshSiteReachability();
      return { success: true, ...result };
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'status',
        title: '检测站点存活状态',
        dedupeKey: 'refresh-all-site-reachability',
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const summary = (currentTask.result as { summary?: { alive: number; unreachable: number } })?.summary;
          if (!summary) return '站点存活检测已完成';
          return `站点存活检测完成：可达 ${summary.alive}，不可达 ${summary.unreachable}`;
        },
        failureMessage: (currentTask) => `站点存活检测失败：${currentTask.error || 'unknown error'}`,
      },
      async () => executeRefreshSiteReachability(),
    );

    return {
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused ? '站点存活检测进行中，请稍后查看任务中心' : '已开始检测站点存活状态，请稍后查看任务中心',
    };
  });

  app.post<{ Body?: { wait?: boolean; dryRun?: boolean } }>('/api/sites/cleanup-unreachable', async (request) => {
    const dryRun = request.body?.dryRun === true;
    if (request.body?.wait) {
      const result = await executeCleanupUnreachableSites(dryRun);
      return { success: true, ...result };
    }

    const dedupeKey = dryRun ? 'cleanup-unreachable-sites-dryrun' : 'cleanup-unreachable-sites';
    const title = dryRun ? '预检失活站点（不删除）' : '移除失活站点及账号';

    const { task, reused } = startBackgroundTask(
      {
        type: 'status',
        title,
        dedupeKey,
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const summary = (currentTask.result as { summary?: { unreachableSites: number; removedSites: number; removedAccounts: number; dryRun: boolean } })?.summary;
          if (!summary) return `${title}已完成`;
          if (summary.dryRun) return `预检完成：不可达站点 ${summary.unreachableSites}`;
          return `移除完成：站点 ${summary.removedSites}，账号 ${summary.removedAccounts}`;
        },
        failureMessage: (currentTask) => `${title}失败：${currentTask.error || 'unknown error'}`,
      },
      async () => executeCleanupUnreachableSites(dryRun),
    );

    return {
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused ? `${title}进行中，请稍后查看任务中心` : `已开始${title}，请稍后查看任务中心`,
    };
  });
}
