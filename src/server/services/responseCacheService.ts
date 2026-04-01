import crypto from 'crypto';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { config } from '../config.js';
import * as dbIndex from '../db/index.js';

let responseCacheAvailable: boolean | null = null;
type ResponseCacheTable = typeof dbIndex.schema.responseCache;
type ResponseCacheRow = ResponseCacheTable['$inferSelect'];

type DbClient = typeof dbIndex.db;

function getDb(): DbClient | null {
  return ((dbIndex as { db?: DbClient }).db) ?? null;
}

function getRuntimeDbDialect(): string | null {
  const candidate = (dbIndex as { runtimeDbDialect?: unknown }).runtimeDbDialect;
  return typeof candidate === 'string' ? candidate : null;
}

function getResponseCacheTable(): ResponseCacheTable | null {
  const schema = (dbIndex as { schema?: typeof dbIndex.schema }).schema;
  return schema?.responseCache ?? null;
}

function getHasResponseCacheTable(): (() => Promise<boolean>) | null {
  if (!Object.prototype.hasOwnProperty.call(dbIndex, 'hasResponseCacheTable')) {
    return null;
  }
  const candidate = (dbIndex as { hasResponseCacheTable?: unknown }).hasResponseCacheTable;
  return typeof candidate === 'function' ? candidate as () => Promise<boolean> : null;
}

export interface CacheableRequest {
  model: string;
  messages: unknown;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  stop?: unknown;
  seed?: number | null;
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  reasoning?: unknown;
  modalities?: unknown;
  input?: unknown;
  routeScope?: string | null;
  [key: string]: unknown;
}

export interface CachedResponse {
  body: string;
  isStream: boolean;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
}

function normalizeFiniteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function normalizePositiveInt(value: unknown): number {
  return Math.max(0, Math.round(normalizeFiniteNumber(value, 0)));
}

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value ?? null;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, stableSortValue(record[key])]),
  );
}

function roundCost(value: unknown): number {
  return Math.round(Math.max(0, normalizeFiniteNumber(value, 0)) * 1_000_000) / 1_000_000;
}

export async function isResponseCacheAvailable(): Promise<boolean> {
  if (responseCacheAvailable !== null) {
    return responseCacheAvailable;
  }
  const hasResponseCacheTable = getHasResponseCacheTable();
  if (!hasResponseCacheTable || !getResponseCacheTable()) {
    responseCacheAvailable = false;
    return responseCacheAvailable;
  }
  responseCacheAvailable = await hasResponseCacheTable();
  return responseCacheAvailable;
}

export function resetResponseCacheAvailabilityForTests(): void {
  responseCacheAvailable = null;
}

export function buildRouteScope(input: {
  routeId?: unknown;
  siteId?: unknown;
  actualModel?: unknown;
}): string | null {
  const routeId = Number.isFinite(Number(input.routeId)) ? Math.trunc(Number(input.routeId)) : null;
  const siteId = Number.isFinite(Number(input.siteId)) ? Math.trunc(Number(input.siteId)) : null;
  const actualModel = typeof input.actualModel === 'string' && input.actualModel.trim().length > 0
    ? input.actualModel.trim()
    : null;

  if (routeId === null && siteId === null && actualModel === null) {
    return null;
  }

  return `route:${routeId ?? 'none'}|site:${siteId ?? 'none'}|actual:${actualModel ?? 'none'}`;
}

/**
 * 生成缓存 key（SHA256，64 字符十六进制）。
 * 仅对确定性非流式请求生效；routeScope 用于隔离不同上游路由/站点的响应差异。
 */
export function buildCacheKey(req: CacheableRequest): string | null {
  const temp = req.temperature;
  if (typeof temp === 'number' && temp > 0) return null;

  const payload = JSON.stringify(stableSortValue({
    routeScope: typeof req.routeScope === 'string' && req.routeScope.trim().length > 0 ? req.routeScope.trim() : null,
    model: req.model,
    messages: req.messages ?? req.input ?? null,
    temperature: temp ?? null,
    top_p: req.top_p ?? null,
    max_tokens: req.max_tokens ?? null,
    stop: req.stop ?? null,
    seed: req.seed ?? null,
    tools: req.tools ?? null,
    tool_choice: req.tool_choice ?? null,
    response_format: req.response_format ?? null,
    reasoning: req.reasoning ?? null,
    modalities: req.modalities ?? null,
  }));

  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function readCachedRow(cacheKey: string): Promise<ResponseCacheRow | null> {
  if (!await isResponseCacheAvailable()) {
    return null;
  }

  const responseCacheTable = getResponseCacheTable();
  if (!responseCacheTable) {
    responseCacheAvailable = false;
    return null;
  }

  const db = getDb();
  if (!db) {
    responseCacheAvailable = false;
    return null;
  }

  try {
    const row = await db
      .select()
      .from(responseCacheTable)
      .where(eq(responseCacheTable.cacheKey, cacheKey))
      .get();
    return row ?? null;
  } catch {
    responseCacheAvailable = false;
    return null;
  }
}

function mapCachedRow(row: ResponseCacheRow): CachedResponse {
  return {
    body: row.responseBody,
    isStream: row.isStream ?? false,
    promptTokens: normalizePositiveInt(row.promptTokens),
    completionTokens: normalizePositiveInt(row.completionTokens),
    estimatedCost: roundCost((row as { estimatedCost?: unknown }).estimatedCost ?? 0),
  };
}

export async function lookupResponseCache(cacheKey: string): Promise<CachedResponse | null> {
  const row = await readCachedRow(cacheKey);
  if (!row) return null;

  const responseCacheTable = getResponseCacheTable();
  if (!responseCacheTable) {
    responseCacheAvailable = false;
    return null;
  }

  const db = getDb();
  if (!db) {
    responseCacheAvailable = false;
    return null;
  }

  const now = new Date();
  if (new Date(row.expiresAt) <= now) {
    void db.delete(responseCacheTable)
      .where(eq(responseCacheTable.cacheKey, cacheKey))
      .run()
      .catch(() => {});
    return null;
  }

  void db.update(responseCacheTable)
    .set({ hitCount: sql`${responseCacheTable.hitCount} + 1` as never })
    .where(eq(responseCacheTable.cacheKey, cacheKey))
    .run()
    .catch(() => {});

  return mapCachedRow(row);
}

export async function lookupStaleResponseCache(
  cacheKey: string,
  maxStaleMs = config.responseCacheStaleIfErrorMs,
): Promise<CachedResponse | null> {
  const row = await readCachedRow(cacheKey);
  if (!row) return null;

  const expiresAtMs = new Date(row.expiresAt).getTime();
  const nowMs = Date.now();
  if (Number.isNaN(expiresAtMs)) return null;
  if ((nowMs - expiresAtMs) > Math.max(1_000, maxStaleMs)) return null;

  return mapCachedRow(row);
}

export async function writeResponseCache(
  cacheKey: string,
  model: string,
  response: CachedResponse,
  ttlMs = config.responseCacheTtlMs,
): Promise<void> {
  if (!await isResponseCacheAvailable()) {
    return;
  }

  const responseCacheTable = getResponseCacheTable();
  if (!responseCacheTable) {
    responseCacheAvailable = false;
    return;
  }

  const db = getDb();
  if (!db) {
    responseCacheAvailable = false;
    return;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const values = {
    cacheKey,
    model,
    responseBody: response.body,
    isStream: response.isStream,
    promptTokens: normalizePositiveInt(response.promptTokens),
    completionTokens: normalizePositiveInt(response.completionTokens),
    estimatedCost: roundCost(response.estimatedCost),
    hitCount: 0,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  try {
    if (getRuntimeDbDialect() === 'mysql') {
      const existing = await db
        .select({ id: responseCacheTable.id })
        .from(responseCacheTable)
        .where(eq(responseCacheTable.cacheKey, cacheKey))
        .get();
      if (existing) {
        await db
          .update(responseCacheTable)
          .set(values)
          .where(eq(responseCacheTable.cacheKey, cacheKey))
          .run();
      } else {
        await db.insert(responseCacheTable).values(values).run();
      }
      return;
    }

    await (db.insert(responseCacheTable).values(values) as any)
      .onConflictDoUpdate({
        target: responseCacheTable.cacheKey,
        set: values,
      })
      .run();
  } catch {
    responseCacheAvailable = false;
  }
}

export const __responseCacheServiceTestUtils = {
  buildRouteScope,
};

export async function pruneResponseCache(): Promise<void> {
  if (!await isResponseCacheAvailable()) {
    return;
  }

  const responseCacheTable = getResponseCacheTable();
  if (!responseCacheTable) {
    responseCacheAvailable = false;
    return;
  }

  const db = getDb();
  if (!db) {
    responseCacheAvailable = false;
    return;
  }

  const now = new Date().toISOString();
  try {
    await db
      .delete(responseCacheTable)
      .where(lt(responseCacheTable.expiresAt, now))
      .run();

    const rows = await db
      .select({ id: responseCacheTable.id })
      .from(responseCacheTable)
      .orderBy(desc(responseCacheTable.hitCount), desc(responseCacheTable.createdAt))
      .all();

    if (rows.length > config.responseCacheMaxRows) {
      const idsToDelete = rows.slice(config.responseCacheMaxRows).map((row: { id: number }) => row.id);
      for (const id of idsToDelete) {
        await db
          .delete(responseCacheTable)
          .where(and(eq(responseCacheTable.id, id)))
          .run();
      }
    }
  } catch {
    responseCacheAvailable = false;
  }
}
