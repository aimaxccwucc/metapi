import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import {
  getDownstreamApiKeyById,
  listDownstreamApiKeys,
  normalizeDownstreamApiKeyPayload,
  toDownstreamApiKeyPolicyView,
  toPersistenceJson,
} from '../../services/downstreamApiKeyService.js';

function parseRouteId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function validateKeyShape(key: string): boolean {
  return key.startsWith('sk-') && key.length >= 6;
}

function looksLikeUniqueViolation(error: unknown): boolean {
  const message = (error as Error | undefined)?.message || '';
  return message.includes('UNIQUE constraint failed') && message.includes('downstream_api_keys.key');
}

export async function downstreamApiKeysRoutes(app: FastifyInstance) {
  app.get('/api/downstream-keys', async () => {
    return {
      success: true,
      items: await listDownstreamApiKeys(),
    };
  });

  app.post<{
    Body: {
      name?: unknown;
      key?: unknown;
      description?: unknown;
      enabled?: unknown;
      expiresAt?: unknown;
      maxCost?: unknown;
      maxRequests?: unknown;
      supportedModels?: unknown;
      allowedRouteIds?: unknown;
      siteWeightMultipliers?: unknown;
    };
  }>('/api/downstream-keys', async (request, reply) => {
    let normalized: ReturnType<typeof normalizeDownstreamApiKeyPayload>;
    try {
      normalized = normalizeDownstreamApiKeyPayload(request.body || {});
    } catch (error: unknown) {
      return reply.code(400).send({ success: false, message: (error as Error)?.message || '参数无效' });
    }

    if (!normalized.name) {
      return reply.code(400).send({ success: false, message: 'name 不能为空' });
    }
    if (!normalized.key) {
      return reply.code(400).send({ success: false, message: 'key 不能为空' });
    }
    if (!validateKeyShape(normalized.key)) {
      return reply.code(400).send({ success: false, message: 'key 必须以 sk- 开头且长度至少 6' });
    }

    const nowIso = new Date().toISOString();

    try {
      const insertedResult = await db.insert(schema.downstreamApiKeys).values({
        name: normalized.name,
        key: normalized.key,
        description: normalized.description,
        enabled: normalized.enabled,
        expiresAt: normalized.expiresAt,
        maxCost: normalized.maxCost,
        usedCost: 0,
        maxRequests: normalized.maxRequests,
        usedRequests: 0,
        supportedModels: toPersistenceJson(normalized.supportedModels),
        allowedRouteIds: toPersistenceJson(normalized.allowedRouteIds),
        siteWeightMultipliers: toPersistenceJson(normalized.siteWeightMultipliers),
        createdAt: nowIso,
        updatedAt: nowIso,
      }).run();
      const insertedId = Number(insertedResult.lastInsertRowid || 0);
      if (insertedId <= 0) {
        return reply.code(500).send({ success: false, message: '创建失败' });
      }
      const inserted = await db.select().from(schema.downstreamApiKeys)
        .where(eq(schema.downstreamApiKeys.id, insertedId))
        .get();
      if (!inserted) {
        return reply.code(500).send({ success: false, message: '创建失败' });
      }

      return {
        success: true,
        item: toDownstreamApiKeyPolicyView(inserted),
      };
    } catch (error: unknown) {
      if (looksLikeUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'API key 已存在' });
      }
      return reply.code(500).send({ success: false, message: (error as Error)?.message || '创建失败' });
    }
  });

  app.put<{
    Params: { id: string };
    Body: {
      name?: unknown;
      key?: unknown;
      description?: unknown;
      enabled?: unknown;
      expiresAt?: unknown;
      maxCost?: unknown;
      maxRequests?: unknown;
      supportedModels?: unknown;
      allowedRouteIds?: unknown;
      siteWeightMultipliers?: unknown;
    };
  }>('/api/downstream-keys/:id', async (request, reply) => {
    const id = parseRouteId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: 'id 无效' });
    }

    const existing = await db.select().from(schema.downstreamApiKeys)
      .where(eq(schema.downstreamApiKeys.id, id))
      .get();

    if (!existing) {
      return reply.code(404).send({ success: false, message: 'API key 不存在' });
    }

    const existingView = toDownstreamApiKeyPolicyView(existing);
    let normalized: ReturnType<typeof normalizeDownstreamApiKeyPayload>;
    try {
      normalized = normalizeDownstreamApiKeyPayload({
        name: request.body?.name ?? existing.name,
        key: request.body?.key ?? existing.key,
        description: request.body?.description ?? existing.description,
        enabled: request.body?.enabled ?? existing.enabled,
        expiresAt: request.body?.expiresAt ?? existing.expiresAt,
        maxCost: request.body?.maxCost ?? existing.maxCost,
        maxRequests: request.body?.maxRequests ?? existing.maxRequests,
        supportedModels: request.body?.supportedModels ?? existingView.supportedModels,
        allowedRouteIds: request.body?.allowedRouteIds ?? existingView.allowedRouteIds,
        siteWeightMultipliers: request.body?.siteWeightMultipliers ?? existingView.siteWeightMultipliers,
      });
    } catch (error: unknown) {
      return reply.code(400).send({ success: false, message: (error as Error)?.message || '参数无效' });
    }

    if (!normalized.name) {
      return reply.code(400).send({ success: false, message: 'name 不能为空' });
    }
    if (!normalized.key) {
      return reply.code(400).send({ success: false, message: 'key 不能为空' });
    }
    if (!validateKeyShape(normalized.key)) {
      return reply.code(400).send({ success: false, message: 'key 必须以 sk- 开头且长度至少 6' });
    }

    const nowIso = new Date().toISOString();
    try {
      await db.update(schema.downstreamApiKeys).set({
        name: normalized.name,
        key: normalized.key,
        description: normalized.description,
        enabled: normalized.enabled,
        expiresAt: normalized.expiresAt,
        maxCost: normalized.maxCost,
        maxRequests: normalized.maxRequests,
        supportedModels: toPersistenceJson(normalized.supportedModels),
        allowedRouteIds: toPersistenceJson(normalized.allowedRouteIds),
        siteWeightMultipliers: toPersistenceJson(normalized.siteWeightMultipliers),
        updatedAt: nowIso,
      }).where(eq(schema.downstreamApiKeys.id, id)).run();

      const updated = getDownstreamApiKeyById(id);
      return {
        success: true,
        item: updated,
      };
    } catch (error: unknown) {
      if (looksLikeUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'API key 已存在' });
      }
      return reply.code(500).send({ success: false, message: (error as Error)?.message || '更新失败' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/downstream-keys/:id/reset-usage', async (request, reply) => {
    const id = parseRouteId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: 'id 无效' });
    }

    const existing = getDownstreamApiKeyById(id);
    if (!existing) {
      return reply.code(404).send({ success: false, message: 'API key 不存在' });
    }

    await db.update(schema.downstreamApiKeys).set({
      usedCost: 0,
      usedRequests: 0,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.downstreamApiKeys.id, id)).run();

    return {
      success: true,
      item: getDownstreamApiKeyById(id),
    };
  });

  app.delete<{ Params: { id: string } }>('/api/downstream-keys/:id', async (request, reply) => {
    const id = parseRouteId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: 'id 无效' });
    }

    const existing = getDownstreamApiKeyById(id);
    if (!existing) {
      return reply.code(404).send({ success: false, message: 'API key 不存在' });
    }

    await db.delete(schema.downstreamApiKeys)
      .where(eq(schema.downstreamApiKeys.id, id))
      .run();

    return { success: true };
  });
}
