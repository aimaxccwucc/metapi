import crypto from 'crypto';
import { desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { config } from '../config.js';
import * as dbIndex from '../db/index.js';

let responseCacheAvailable: boolean | null = null;
let responseCacheAvailabilityRetryAtMs = 0;
const RESPONSE_CACHE_AVAILABILITY_RETRY_MS = 30_000;
type ResponseCacheTable = typeof dbIndex.schema.responseCache;
type ResponseCacheRow = ResponseCacheTable['$inferSelect'];

type DbClient = typeof dbIndex.db;

type ResponseCacheFailureKind = 'read' | 'write' | 'prune';

export type ResponseCacheRuntimeStatus = {
  ready: boolean;
  availabilityChecked: boolean;
  lastError: string | null;
  readFailures: number;
  writeFailures: number;
  pruneFailures: number;
  pruneDeletedExpiredRows: number;
  pruneDeletedOverflowRows: number;
  savedTokens: number;
  savedCost: number;
  hits: number;
  staleHits: number;
  misses: number;
  inflightJoins: number;
  inflightWrites: number;
  inflightEvictions: number;
};

function buildInitialRuntimeStatus(): ResponseCacheRuntimeStatus {
  return {
    ready: false,
    availabilityChecked: false,
    lastError: null,
    readFailures: 0,
    writeFailures: 0,
    pruneFailures: 0,
    pruneDeletedExpiredRows: 0,
    pruneDeletedOverflowRows: 0,
    savedTokens: 0,
    savedCost: 0,
    hits: 0,
    staleHits: 0,
    misses: 0,
    inflightJoins: 0,
    inflightWrites: 0,
    inflightEvictions: 0,
  };
}

const responseCacheRuntimeStatus = buildInitialRuntimeStatus();
const responseCacheInflight = new Map<string, { promise: Promise<InflightResponseCacheResult>; resolve: (result: InflightResponseCacheResult) => void; reject: (reason?: unknown) => void; createdAtMs: number }>();

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

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  return fallback;
}

function markResponseCacheReady(): void {
  responseCacheAvailable = true;
  responseCacheAvailabilityRetryAtMs = 0;
  responseCacheRuntimeStatus.availabilityChecked = true;
  responseCacheRuntimeStatus.ready = true;
  responseCacheRuntimeStatus.lastError = null;
}

function markResponseCacheUnavailable(reason: string): void {
  responseCacheAvailable = false;
  responseCacheAvailabilityRetryAtMs = Date.now() + RESPONSE_CACHE_AVAILABILITY_RETRY_MS;
  responseCacheRuntimeStatus.availabilityChecked = true;
  responseCacheRuntimeStatus.ready = false;
  responseCacheRuntimeStatus.lastError = reason;
}

function recordRuntimeFailure(kind: ResponseCacheFailureKind, error: unknown): void {
  const message = normalizeErrorMessage(error, `response cache ${kind} failed`);
  if (kind === 'read') responseCacheRuntimeStatus.readFailures += 1;
  if (kind === 'write') responseCacheRuntimeStatus.writeFailures += 1;
  if (kind === 'prune') responseCacheRuntimeStatus.pruneFailures += 1;
  markResponseCacheUnavailable(message);
}

function recordSavedCacheResponse(kind: 'hit' | 'stale', response: CachedResponse): void {
  if (kind === 'hit') {
    responseCacheRuntimeStatus.hits += 1;
  } else {
    responseCacheRuntimeStatus.staleHits += 1;
  }
  responseCacheRuntimeStatus.savedTokens += Math.max(0, response.promptTokens + response.completionTokens);
  responseCacheRuntimeStatus.savedCost = roundCost(responseCacheRuntimeStatus.savedCost + response.estimatedCost);
}

export function recordResponseCacheMiss(): void {
  responseCacheRuntimeStatus.misses += 1;
}

export function getResponseCacheRuntimeStatus(): ResponseCacheRuntimeStatus {
  return {
    ...responseCacheRuntimeStatus,
    savedCost: roundCost(responseCacheRuntimeStatus.savedCost),
  };
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
  surface?: string | null;
  requestFingerprint?: unknown;
  [key: string]: unknown;
}

export interface CachedResponse {
  body: string;
  isStream: boolean;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
}

export type InflightResponseCacheResult = {
  response: CachedResponse;
  cacheStatus: 'hit' | 'stale';
};

export type InflightResponseCacheFailure = {
  statusCode: number;
  payload: unknown;
};

export type InflightResponseCacheWrite = {
  promise: Promise<InflightResponseCacheResult>;
  resolve: (result: InflightResponseCacheResult) => void;
  reject: (reason?: InflightResponseCacheFailure | unknown) => void;
};

export function isInflightResponseCacheFailure(value: unknown): value is InflightResponseCacheFailure {
  return !!value
    && typeof value === 'object'
    && Number.isInteger((value as { statusCode?: unknown }).statusCode)
    && Object.prototype.hasOwnProperty.call(value, 'payload');
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
    const now = Date.now();
    if (responseCacheAvailable === false && now >= responseCacheAvailabilityRetryAtMs) {
      responseCacheAvailable = null;
    } else {
      responseCacheRuntimeStatus.availabilityChecked = true;
      responseCacheRuntimeStatus.ready = responseCacheAvailable;
      return responseCacheAvailable;
    }
  }

  const hasResponseCacheTable = getHasResponseCacheTable();
  if (!hasResponseCacheTable || !getResponseCacheTable()) {
    markResponseCacheUnavailable('response cache schema capability is unavailable');
    return false;
  }

  try {
    responseCacheAvailable = await hasResponseCacheTable();
    if (responseCacheAvailable) {
      markResponseCacheReady();
    } else {
      markResponseCacheUnavailable('response cache table is missing');
    }
    return responseCacheAvailable;
  } catch (error) {
    recordRuntimeFailure('read', error);
    return false;
  }
}

export function resetResponseCacheAvailabilityForTests(): void {
  responseCacheAvailable = null;
  responseCacheAvailabilityRetryAtMs = 0;
  responseCacheInflight.clear();
  Object.assign(responseCacheRuntimeStatus, buildInitialRuntimeStatus());
}

function pruneInflightResponseCache(nowMs = Date.now()): void {
  for (const [cacheKey, entry] of responseCacheInflight.entries()) {
    if ((nowMs - entry.createdAtMs) < config.responseCacheInflightTtlMs) continue;
    responseCacheInflight.delete(cacheKey);
    responseCacheRuntimeStatus.inflightEvictions += 1;
  }
}

export function getInflightResponseCacheWrite(cacheKey: string): Promise<InflightResponseCacheResult> | null {
  pruneInflightResponseCache();
  const entry = responseCacheInflight.get(cacheKey);
  if (!entry) return null;
  responseCacheRuntimeStatus.inflightJoins += 1;
  return entry.promise;
}

export function reserveInflightResponseCacheWrite(cacheKey: string): InflightResponseCacheWrite {
  pruneInflightResponseCache();
  const existing = responseCacheInflight.get(cacheKey);
  if (existing) {
    return {
      promise: existing.promise,
      resolve: existing.resolve,
      reject: existing.reject,
    };
  }

  let resolvePromise!: (result: InflightResponseCacheResult) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<InflightResponseCacheResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const entry = {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    createdAtMs: Date.now(),
  };
  responseCacheRuntimeStatus.inflightWrites += 1;
  responseCacheInflight.set(cacheKey, entry);
  promise.finally(() => {
    const current = responseCacheInflight.get(cacheKey);
    if (current?.promise === promise) {
      responseCacheInflight.delete(cacheKey);
    }
  }).catch(() => {});
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

export function registerInflightResponseCacheWrite(cacheKey: string, task: Promise<CachedResponse>): Promise<InflightResponseCacheResult> {
  const reserved = reserveInflightResponseCacheWrite(cacheKey);
  task.then((response) => reserved.resolve({ response, cacheStatus: 'hit' }), reserved.reject);
  return reserved.promise;
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
 * 仅对确定性非流式请求生效；routeScope/surface/requestFingerprint 用于隔离不同 surface、上游路由和完整请求体差异。
 */
export function buildCacheKey(req: CacheableRequest): string | null {
  const temp = req.temperature;
  if (typeof temp === 'number' && temp > 0) return null;
  const topP = req.top_p;
  if (typeof topP === 'number' && topP > 0 && topP < 1) return null;

  const payload = JSON.stringify(stableSortValue({
    surface: typeof req.surface === 'string' && req.surface.trim().length > 0 ? req.surface.trim() : null,
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
    requestFingerprint: req.requestFingerprint ?? null,
  }));

  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function readCachedRow(cacheKey: string): Promise<ResponseCacheRow | null> {
  if (!await isResponseCacheAvailable()) {
    return null;
  }

  const responseCacheTable = getResponseCacheTable();
  if (!responseCacheTable) {
    markResponseCacheUnavailable('response cache schema is unavailable at runtime');
    return null;
  }

  const db = getDb();
  if (!db) {
    markResponseCacheUnavailable('response cache database handle is unavailable');
    return null;
  }

  try {
    const row = await db
      .select()
      .from(responseCacheTable)
      .where(eq(responseCacheTable.cacheKey, cacheKey))
      .get();
    return row ?? null;
  } catch (error) {
    recordRuntimeFailure('read', error);
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
    markResponseCacheUnavailable('response cache schema is unavailable at runtime');
    return null;
  }

  const db = getDb();
  if (!db) {
    markResponseCacheUnavailable('response cache database handle is unavailable');
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

  const cached = mapCachedRow(row);
  recordSavedCacheResponse('hit', cached);
  return cached;
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

  const cached = mapCachedRow(row);
  recordSavedCacheResponse('stale', cached);
  return cached;
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
    markResponseCacheUnavailable('response cache schema is unavailable at runtime');
    return;
  }

  const db = getDb();
  if (!db) {
    markResponseCacheUnavailable('response cache database handle is unavailable');
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
      markResponseCacheReady();
      return;
    }

    await (db.insert(responseCacheTable).values(values) as any)
      .onConflictDoUpdate({
        target: responseCacheTable.cacheKey,
        set: values,
      })
      .run();
    markResponseCacheReady();
  } catch (error) {
    recordRuntimeFailure('write', error);
  }
}

export const __responseCacheServiceTestUtils = {
  buildRouteScope,
  pruneInflightResponseCache,
};

export async function pruneResponseCache(): Promise<void> {
  if (!await isResponseCacheAvailable()) {
    return;
  }

  const responseCacheTable = getResponseCacheTable();
  if (!responseCacheTable) {
    markResponseCacheUnavailable('response cache schema is unavailable at runtime');
    return;
  }

  const db = getDb();
  if (!db) {
    markResponseCacheUnavailable('response cache database handle is unavailable');
    return;
  }

  const now = new Date().toISOString();
  try {
    // Delete expired rows directly with SQL condition instead of select-then-delete.
    const expiredResult = await db
      .delete(responseCacheTable)
      .where(lt(responseCacheTable.expiresAt, now))
      .run();
    responseCacheRuntimeStatus.pruneDeletedExpiredRows +=
      (expiredResult as { changes?: number; affectedRows?: number; rowCount?: number }).changes
      ?? (expiredResult as { affectedRows?: number }).affectedRows
      ?? 0;

    // Only count + sort-delete if we might exceed maxRows.
    const [{ total }] = await db.select({ total: sql`count(*)`.mapWith(Number) }).from(responseCacheTable);
    if (total > config.responseCacheMaxRows) {
      const rows = await db
        .select({ id: responseCacheTable.id })
        .from(responseCacheTable)
        .orderBy(desc(responseCacheTable.hitCount), desc(responseCacheTable.createdAt))
        .all();
      const idsToDelete = rows.slice(config.responseCacheMaxRows).map((row: { id: number }) => row.id);
      await db
        .delete(responseCacheTable)
        .where(inArray(responseCacheTable.id, idsToDelete))
        .run();
      responseCacheRuntimeStatus.pruneDeletedOverflowRows += idsToDelete.length;
    }
    markResponseCacheReady();
  } catch (error) {
    recordRuntimeFailure('prune', error);
  }
}
