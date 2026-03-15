import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { importAllApiHubAccountsMerge } from '../../services/backupService.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { performFactoryReset } from '../../services/factoryResetService.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';

async function appendSettingsEvent(input: {
  type: 'checkin' | 'balance' | 'proxy' | 'status' | 'token';
  title: string;
  message: string;
  level?: 'info' | 'warning' | 'error';
}) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    await db.insert(schema.events).values({
      type: input.type,
      title: input.title,
      message: input.message,
      level: input.level || 'info',
      relatedType: 'settings',
      createdAt,
    }).run();
  } catch {}
}

export async function registerSettingsCustomRoutes(app: FastifyInstance) {
  app.post<{ Body: { data?: Record<string, unknown> } }>('/api/settings/backup/import-all-api-hub-merge', async (request, reply) => {
    const payload = request.body?.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return reply.code(400).send({ success: false, message: '导入数据格式错误：需要 JSON 对象' });
    }

    try {
      const result = await importAllApiHubAccountsMerge(payload);
      return {
        success: true,
        message: 'all-api-hub 账号已合并导入',
        ...result,
      };
    } catch (err: any) {
      return reply.code(400).send({
        success: false,
        message: err?.message || '导入失败',
      });
    }
  });

  app.post('/api/settings/maintenance/factory-reset', async (_, reply) => {
    try {
      await performFactoryReset();
      return {
        success: true,
      };
    } catch (err: any) {
      return reply.code(500).send({
        success: false,
        message: err?.message || '重新初始化系统失败',
      });
    }
  });

  app.post('/api/settings/maintenance/clear-cache', async (_, reply) => {
    const deletedModelAvailability = (await db.delete(schema.modelAvailability).run()).changes;
    const deletedRouteChannels = (await db.delete(schema.routeChannels).run()).changes;
    const deletedTokenRoutes = (await db.delete(schema.tokenRoutes).run()).changes;

    const { task, reused } = startBackgroundTask(
      {
        type: 'maintenance',
        title: '清理缓存并重建路由',
        dedupeKey: 'refresh-models-and-rebuild-routes',
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const rebuild = (currentTask.result as any)?.rebuild;
          if (!rebuild) return '缓存清理后重建路由已完成';
          return `缓存清理后重建完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
        },
        failureMessage: (currentTask) => `缓存清理后重建失败：${currentTask.error || 'unknown error'}`,
      },
      async () => refreshModelsAndRebuildRoutes(),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      message: '缓存已清理，重建路由已开始执行',
      deletedModelAvailability,
      deletedRouteChannels,
      deletedTokenRoutes,
    });
  });

  app.post('/api/settings/maintenance/clear-usage', async () => {
    const deletedProxyLogs = (await db.delete(schema.proxyLogs).run()).changes;

    await db.update(schema.routeChannels).set({
      successCount: 0,
      failCount: 0,
      totalLatencyMs: 0,
      totalCost: 0,
      lastUsedAt: null,
      lastFailAt: null,
      cooldownUntil: null,
    }).run();

    await db.update(schema.accounts).set({
      balanceUsed: 0,
      updatedAt: new Date().toISOString(),
    }).run();

    await appendSettingsEvent({
      type: 'status',
      title: '占用统计与使用日志已清理',
      message: `已清理使用日志 ${deletedProxyLogs} 条，并重置路由与账号占用统计`,
      level: 'warning',
    });

    return {
      success: true,
      message: '占用统计已清理',
      deletedProxyLogs,
    };
  });
}
