import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, eq } from 'drizzle-orm';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { getDownstreamRoutingPolicy } from './downstreamPolicy.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { isModelAllowedByPolicyOrAllowedRoutes } from '../../services/downstreamApiKeyService.js';

function isSearchPseudoModel(modelName: string): boolean {
  const normalized = (modelName || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === '__search' || /^__.+_search$/.test(normalized);
}

export async function modelsProxyRoute(app: FastifyInstance) {
  app.get('/v1/models', async (request) => {
    const downstreamPolicy = getDownstreamRoutingPolicy(request);

    const readModels = async () => {
      const rows = await db.select({ modelName: schema.modelAvailability.modelName })
        .from(schema.modelAvailability)
        .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.modelAvailability.available, true),
            eq(schema.accounts.status, 'active'),
            eq(schema.sites.status, 'active'),
          ),
        )
        .all();
      const routeAliases = (await db.select({ displayName: schema.tokenRoutes.displayName })
        .from(schema.tokenRoutes)
        .where(eq(schema.tokenRoutes.enabled, true))
        .all())
        .map((row) => (row.displayName || '').trim())
        .filter((name) => name.length > 0);
      const deduped = Array.from(new Set([
        ...rows.map((r) => r.modelName),
        ...routeAliases,
      ]))
        .filter((modelName) => !isSearchPseudoModel(modelName))
        .sort();
      const allowed: string[] = [];
      for (const modelName of deduped) {
        if (!await isModelAllowedByPolicyOrAllowedRoutes(modelName, downstreamPolicy)) {
          continue;
        }
        const decision = await tokenRouter.explainSelection(modelName, [], downstreamPolicy);
        if (typeof decision.selectedChannelId === 'number') {
          allowed.push(modelName);
        }
      }
      return allowed;
    };

    let models = await readModels();
    if (models.length === 0) {
      await refreshModelsAndRebuildRoutes();
      models = await readModels();
    }

    const wantsClaudeFormat = typeof request.headers['anthropic-version'] === 'string'
      || typeof request.headers['x-api-key'] === 'string';
    if (wantsClaudeFormat) {
      const data = models.map((id) => ({
        id,
        type: 'model',
        display_name: id,
        created_at: new Date().toISOString(),
      }));
      return {
        data,
        first_id: data[0]?.id || null,
        last_id: data[data.length - 1]?.id || null,
        has_more: false,
      };
    }

    return {
      object: 'list',
      data: models.map(id => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'metapi',
      })),
    };
  });
}
