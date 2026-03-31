import crypto from 'crypto';
import { db, schema, runtimeDbDialect } from '../db/index.js';
import { eq, lt, desc } from 'drizzle-orm';

// 默认 TTL：1 小时
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_STALE_IF_ERROR_MS = 10 * 60 * 1000;
// 缓存最大行数（超出时按 hit_count 升序淘汰）
const MAX_CACHE_ROWS = 2000;

export interface CacheableRequest {
  model: string;
  messages: unknown;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  [key: string]: unknown;
}

export interface CachedResponse {
  body: string;
  isStream: boolean;
  promptTokens: number;
  completionTokens: number;
}

/**
 * 生成缓存 key（SHA256，64 字符十六进制）。
 * temperature > 0 时返回 null，表示该请求不可缓存。
 */
export function buildCacheKey(req: CacheableRequest): string | null {
  const temp = req.temperature ?? 1;
  if (temp > 0) return null;

  const payload = JSON.stringify({
    model: req.model,
    messages: req.messages,
    top_p: req.top_p ?? null,
    max_tokens: req.max_tokens ?? null,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * 查询缓存。命中时更新 hit_count 并返回内容；未命中或已过期返回 null。
 */
export async function lookupResponseCache(cacheKey: string): Promise<CachedResponse | null> {
  let row: typeof schema.responseCache.$inferSelect | undefined;
  try {
    row = await db
      .select()
      .from(schema.responseCache)
      .where(eq(schema.responseCache.cacheKey, cacheKey))
      .get();
  } catch {
    return null;
  }
  if (!row) return null;

  const now = new Date();
  if (new Date(row.expiresAt) <= now) {
    // 惰性删除过期记录
    db.delete(schema.responseCache)
      .where(eq(schema.responseCache.cacheKey, cacheKey))
      .run()
      .catch(() => {});
    return null;
  }

  // 异步更新命中计数，不阻塞响应
  db.update(schema.responseCache)
    .set({ hitCount: row.hitCount + 1 })
    .where(eq(schema.responseCache.cacheKey, cacheKey))
    .run()
    .catch(() => {});

  return {
    body: row.responseBody,
    isStream: row.isStream ?? false,
    promptTokens: row.promptTokens ?? 0,
    completionTokens: row.completionTokens ?? 0,
  };
}

export async function lookupStaleResponseCache(
  cacheKey: string,
  maxStaleMs = DEFAULT_STALE_IF_ERROR_MS,
): Promise<CachedResponse | null> {
  let row: typeof schema.responseCache.$inferSelect | undefined;
  try {
    row = await db
      .select()
      .from(schema.responseCache)
      .where(eq(schema.responseCache.cacheKey, cacheKey))
      .get();
  } catch {
    return null;
  }
  if (!row) return null;

  const expiresAtMs = new Date(row.expiresAt).getTime();
  const nowMs = Date.now();
  if (Number.isNaN(expiresAtMs)) return null;
  if (expiresAtMs > nowMs) {
    return {
      body: row.responseBody,
      isStream: row.isStream ?? false,
      promptTokens: row.promptTokens ?? 0,
      completionTokens: row.completionTokens ?? 0,
    };
  }
  if ((nowMs - expiresAtMs) > Math.max(1_000, maxStaleMs)) return null;

  return {
    body: row.responseBody,
    isStream: row.isStream ?? false,
    promptTokens: row.promptTokens ?? 0,
    completionTokens: row.completionTokens ?? 0,
  };
}

/**
 * 写入缓存。写入失败不抛出，静默忽略。
 */
export async function writeResponseCache(
  cacheKey: string,
  model: string,
  response: CachedResponse,
  ttlMs = DEFAULT_TTL_MS,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const values = {
    cacheKey,
    model,
    responseBody: response.body,
    isStream: response.isStream,
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
    hitCount: 0,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  try {
    if (runtimeDbDialect === 'mysql') {
      const existing = await db
        .select({ id: schema.responseCache.id })
        .from(schema.responseCache)
        .where(eq(schema.responseCache.cacheKey, cacheKey))
        .get();
      if (existing) {
        await db
          .update(schema.responseCache)
          .set({ ...values })
          .where(eq(schema.responseCache.cacheKey, cacheKey))
          .run();
      } else {
        await db.insert(schema.responseCache).values(values).run();
      }
    } else {
      await (db.insert(schema.responseCache).values(values) as any)
        .onConflictDoUpdate({
          target: schema.responseCache.cacheKey,
          set: { ...values },
        })
        .run();
    }
  } catch {
    // 缓存写入失败不影响主流程
  }
}

/**
 * 清理过期缓存记录，并在超出行数上限时淘汰低命中率记录。
 * 由定时任务调用，不应在请求路径上调用。
 */
export async function pruneResponseCache(): Promise<void> {
  const now = new Date().toISOString();
  try {
    // 1. 删除所有过期记录
    await db
      .delete(schema.responseCache)
      .where(lt(schema.responseCache.expiresAt, now))
      .run();

    // 2. 超出上限时，按 hit_count 升序保留最热的 MAX_CACHE_ROWS 条
    const rows = await db
      .select({ id: schema.responseCache.id })
      .from(schema.responseCache)
      .orderBy(desc(schema.responseCache.hitCount))
      .all();

    if (rows.length > MAX_CACHE_ROWS) {
      const idsToDelete = rows.slice(MAX_CACHE_ROWS).map((r: { id: number }) => r.id);
      for (const id of idsToDelete) {
        await db
          .delete(schema.responseCache)
          .where(eq(schema.responseCache.id, id))
          .run();
      }
    }
  } catch {
    // 淘汰失败不影响服务
  }
}
