import { and, eq } from 'drizzle-orm';
import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import {
  MarketplaceModelProbeError,
  testMarketplaceModelAvailability,
  testMarketplaceModelAvailabilityForCandidate,
} from '../../services/marketplaceModelProbeService.js';
import { tokenRouter } from '../../services/tokenRouter.js';

type PreviewSelectedRouteChannel = NonNullable<Awaited<ReturnType<typeof tokenRouter.previewSelectedChannelForRoute>>>;

async function loadNextRouteSelectedChannel(
  routeId: number,
  modelName: string,
  excludeChannelIds: number[],
): Promise<PreviewSelectedRouteChannel | null> {
  const selected = await tokenRouter.previewSelectedChannelForRoute(routeId, modelName, excludeChannelIds);
  const selectedChannelId = typeof selected?.channel.id === 'number' ? selected.channel.id : null;
  if (!selected || selectedChannelId === null || excludeChannelIds.includes(selectedChannelId)) return null;
  return selected;
}

async function loadMarketplaceProbeCandidateByChannel(channelId: number) {
  const row = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, and(
      eq(schema.routeChannels.tokenId, schema.accountTokens.id),
      eq(schema.accountTokens.enabled, true),
    ))
    .where(eq(schema.routeChannels.id, channelId))
    .get();

  if (!row) return null;

  return {
    channel: row.route_channels,
    candidate: {
      account: row.accounts,
      site: row.sites,
      token: row.account_tokens,
    },
  };
}

export async function registerMarketplaceModelTestRoutes(app: FastifyInstance) {
  app.post<{
    Body?: {
      modelName?: string;
      accountId?: number;
      siteName?: string;
      routeId?: number;
      channelId?: number;
    };
  }>('/api/models/marketplace/test', async (request, reply) => {
    const modelName = String(request.body?.modelName || '').trim();
    if (!modelName) {
      return reply.code(400).send({ success: false, error: 'modelName is required' });
    }

    const accountIdInput = request.body?.accountId;
    const accountId = Number.isFinite(accountIdInput) ? Number(accountIdInput) : null;
    const siteName = String(request.body?.siteName || '').trim();
    const routeIdInput = request.body?.routeId;
    const routeId = Number.isFinite(routeIdInput) ? Number(routeIdInput) : null;
    const channelIdInput = request.body?.channelId;
    let channelId = Number.isFinite(channelIdInput) ? Number(channelIdInput) : null;

    try {
      if (routeId !== null || channelId !== null) {
        const attemptedChannelIds: number[] = [];
        let selectedResult: Awaited<ReturnType<typeof testMarketplaceModelAvailabilityForCandidate>> | null = null;
        let selectedChannelId: number | null = null;
        let resolvedRouteId = routeId;

        while (attemptedChannelIds.length < 64) {
          const selected = channelId !== null
            ? null
            : (routeId !== null ? await loadNextRouteSelectedChannel(routeId, modelName, attemptedChannelIds) : null);
          const candidateChannelId = channelId
            ?? (typeof selected?.channel.id === 'number' ? selected.channel.id : null);
          if (candidateChannelId === null || attemptedChannelIds.includes(candidateChannelId)) break;
          attemptedChannelIds.push(candidateChannelId);

          const loaded = selected
            ? {
              channel: selected.channel,
              candidate: {
                account: selected.account,
                site: selected.site,
                token: selected.token,
              },
            }
            : await loadMarketplaceProbeCandidateByChannel(candidateChannelId);
          if (!loaded) {
            if (channelId !== null) break;
            continue;
          }

          const probeModelName = selected?.actualModel
            || loaded.channel.sourceModel
            || modelName;
          const result = await testMarketplaceModelAvailabilityForCandidate({
            modelName: probeModelName,
            candidate: loaded.candidate,
            preferredTokenId: loaded.channel.tokenId ?? null,
            proxyCanaryForcedChannelId: candidateChannelId,
            forceRealtimeProbeOnListMiss: true,
          });

          if (!selectedResult || result.available) {
            selectedResult = result;
            selectedChannelId = candidateChannelId;
            resolvedRouteId = routeId ?? loaded.channel.routeId;
          }

          if (result.available || channelId !== null) break;
        }

        if (attemptedChannelIds.length === 0) {
          throw new MarketplaceModelProbeError(404, {
            success: false,
            error: 'no_selected_channel_for_route',
            message: 'no selected channel for route',
            modelName,
            routeId,
          });
        }

        if (!selectedResult || selectedChannelId === null) {
          throw new MarketplaceModelProbeError(404, {
            success: false,
            error: 'route_channel_not_found',
            message: 'route channel not found',
            modelName,
            routeId,
            channelId: attemptedChannelIds[0] ?? null,
          });
        }

        return {
          ...selectedResult,
          routeId: resolvedRouteId,
          channelId: selectedChannelId,
        };
      }

      if (accountId === null && !siteName) {
        const selected = await tokenRouter.previewSelectedChannel(modelName);
        const selectedChannelId = typeof selected?.channel.id === 'number' ? selected.channel.id : null;
        if (selectedChannelId !== null) {
          const loaded = await loadMarketplaceProbeCandidateByChannel(selectedChannelId);
          if (loaded) {
            const probeModelName = selected?.actualModel
              || loaded.channel.sourceModel
              || modelName;
            const result = await testMarketplaceModelAvailabilityForCandidate({
              modelName: probeModelName,
              candidate: loaded.candidate,
              preferredTokenId: loaded.channel.tokenId ?? null,
              useLocalProxyCanary: true,
              forceRealtimeProbeOnListMiss: true,
            });

            return {
              ...result,
              routeId: loaded.channel.routeId,
              channelId: selectedChannelId,
            };
          }
        }

        throw new MarketplaceModelProbeError(404, {
          success: false,
          error: 'no_selected_channel_for_model',
          message: 'no selected channel for model',
          modelName,
        });
      }

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
