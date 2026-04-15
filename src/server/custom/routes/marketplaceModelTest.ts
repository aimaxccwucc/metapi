import { FastifyInstance } from 'fastify';
import {
  MarketplaceModelProbeError,
  testMarketplaceModelAvailability,
} from '../../services/marketplaceModelProbeService.js';

export async function registerMarketplaceModelTestRoutes(app: FastifyInstance) {
  app.post<{ Body?: { modelName?: string; accountId?: number; siteName?: string } }>('/api/models/marketplace/test', async (request, reply) => {
    const modelName = String(request.body?.modelName || '').trim();
    if (!modelName) {
      return reply.code(400).send({ success: false, error: 'modelName is required' });
    }

    const accountIdInput = request.body?.accountId;
    const accountId = Number.isFinite(accountIdInput) ? Number(accountIdInput) : null;
    const siteName = String(request.body?.siteName || '').trim();

    try {
      return await testMarketplaceModelAvailability({
        modelName,
        accountId,
        siteName,
        forceRealtimeProbeOnListMiss: true,
      });
    } catch (error) {
      if (error instanceof MarketplaceModelProbeError) {
        return reply.code(error.statusCode).send(error.payload);
      }
      throw error;
    }
  });
}
