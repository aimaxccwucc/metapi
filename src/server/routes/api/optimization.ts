import { FastifyInstance } from 'fastify';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import {
  buildOperationalDiagnosticsText,
  buildOperationalOptimizationOverview,
  readOperationalPolicies,
  syncOperationalProfiles,
  updateOperationalPolicies,
} from '../../services/operationalOptimizationService.js';
import { executeRoutingGovernanceAutoRecoveryPass, recordRoutingGovernanceAutoRecoveryEvent } from '../../services/routingGovernanceAutoRecoveryService.js';

export async function optimizationRoutes(app: FastifyInstance) {
  app.get('/api/optimization/overview', async () => {
    return await buildOperationalOptimizationOverview();
  });

  app.get('/api/optimization/diagnostics-text', async () => {
    return {
      success: true,
      text: await buildOperationalDiagnosticsText(),
    };
  });

  app.post('/api/optimization/sync', async () => {
    const { task, reused } = startBackgroundTask(
      {
        type: 'optimization-sync',
        title: '同步优化画像',
        dedupeKey: 'optimization-sync',
        notifyOnFailure: true,
        successTitle: '优化画像已同步',
        failureTitle: '优化画像同步失败',
      },
      async () => await syncOperationalProfiles(),
    );
    return {
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
    };
  });

  app.get('/api/optimization/policies', async () => {
    return {
      success: true,
      policies: await readOperationalPolicies(),
    };
  });

  app.put<{ Body?: { responseCache?: Record<string, unknown>; retryBudget?: Record<string, unknown> } }>('/api/optimization/policies', async (request) => {
    return {
      success: true,
      policies: await updateOperationalPolicies({
        responseCache: request.body?.responseCache as any,
        retryBudget: request.body?.retryBudget as any,
      }),
    };
  });

  app.post<{ Body?: { limit?: number; includeProbing?: boolean } }>('/api/optimization/recovery-pass', async (request) => {
    const result = await executeRoutingGovernanceAutoRecoveryPass({
      limit: typeof request.body?.limit === 'number' ? request.body.limit : undefined,
      includeProbing: request.body?.includeProbing !== false,
    });
    if (result.scanned > 0 || result.promotedToProbing > 0 || result.restored > 0) {
      await recordRoutingGovernanceAutoRecoveryEvent(result);
    }
    return {
      success: true,
      ...result,
    };
  });
}
