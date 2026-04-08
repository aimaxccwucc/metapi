import { config } from '../config.js';

type HeadersLike = Headers | Record<string, unknown> | null | undefined;

export type ProxyDebugTraceEvent = {
  at: string;
  kind: string;
  traceId: string;
  sessionId: string | null;
  traceHint: string | null;
  requestedModel: string | null;
  actualModel?: string | null;
  downstreamPath?: string | null;
  routeId?: number | null;
  channelId?: number | null;
  siteId?: number | null;
  siteName?: string | null;
  endpoint?: string | null;
  endpointPath?: string | null;
  status?: number | null;
  retryCount?: number | null;
  reason?: string | null;
  detail?: Record<string, unknown> | null;
};

const traceEvents: ProxyDebugTraceEvent[] = [];
const PROXY_DEBUG_TRACE_SETTING_KEY = 'proxy_debug_trace_snapshot_v1';
const PROXY_DEBUG_TRACE_PERSIST_DEBOUNCE_MS = 500;
let snapshotLoaded = false;
let snapshotLoadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> | null = null;
let snapshotContextTag: string | null = null;

function getCurrentContextTag(): string | null {
  const dataDir = (process.env.DATA_DIR || '').trim();
  return dataDir || null;
}

function refreshContext(): void {
  const next = getCurrentContextTag();
  if (next === snapshotContextTag) return;
  traceEvents.length = 0;
  snapshotLoaded = false;
  snapshotLoadPromise = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistInFlight = null;
  snapshotContextTag = next;
}

function normalizeHeadersLike(value: HeadersLike): Record<string, unknown> | null {
  if (!value) return null;

  const headerEntries = value as { entries?: unknown; get?: unknown };
  if (typeof headerEntries.get === 'function' && typeof headerEntries.entries === 'function') {
    return Object.fromEntries(
      [...headerEntries.entries.call(value) as Iterable<[string, string]>]
        .sort((left, right) => left[0].localeCompare(right[0])),
    );
  }
  return null;
}

function normalizeTraceDetailValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTraceDetailValue(item, seen));
  }
  if (typeof value !== 'object') {
    return String(value);
  }

  const headersLike = normalizeHeadersLike(value as HeadersLike);
  if (headersLike) return headersLike;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  const normalizedEntries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
    key,
    normalizeTraceDetailValue(entryValue, seen),
  ]);
  return Object.fromEntries(normalizedEntries);
}

function normalizeTraceLimit(limit: unknown): number {
  const value = Number(limit);
  if (!Number.isFinite(value)) return config.proxyDebugTraceMaxEntries;
  return Math.max(1, Math.min(config.proxyDebugTraceMaxEntries, Math.trunc(value)));
}

function shouldRecordTrace(input: { sessionId?: string | null; traceHint?: string | null }): boolean {
  if (config.proxyDebugTraceEnabled) return true;
  return !!String(input.sessionId || input.traceHint || '').trim();
}

function trimTraceEvents(): void {
  const overflow = traceEvents.length - config.proxyDebugTraceMaxEntries;
  if (overflow > 0) {
    traceEvents.splice(0, overflow);
  }
}

function buildSnapshotPayload() {
  trimTraceEvents();
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    items: traceEvents.slice(-config.proxyDebugTraceMaxEntries),
  };
}

async function persistTraceSnapshot(): Promise<void> {
  refreshContext();
  if (persistInFlight) {
    await persistInFlight;
    return;
  }
  const task = (async () => {
    try {
      const [{ upsertSetting }] = await Promise.all([
        import('../db/upsertSetting.js'),
      ]);
      await upsertSetting(PROXY_DEBUG_TRACE_SETTING_KEY, buildSnapshotPayload());
    } catch {}
  })();
  persistInFlight = task.finally(() => {
    if (persistInFlight === task) {
      persistInFlight = null;
    }
  });
  await persistInFlight;
}

function scheduleTraceSnapshotPersistence(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistTraceSnapshot();
  }, PROXY_DEBUG_TRACE_PERSIST_DEBOUNCE_MS);
}

function normalizeTraceEvent(raw: unknown): ProxyDebugTraceEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  const at = typeof event.at === 'string' ? event.at : new Date().toISOString();
  const kind = typeof event.kind === 'string' ? event.kind : '';
  const traceId = typeof event.traceId === 'string' ? event.traceId : '';
  if (!kind || !traceId) return null;
  return {
    at,
    kind,
    traceId,
    sessionId: typeof event.sessionId === 'string' ? event.sessionId : null,
    traceHint: typeof event.traceHint === 'string' ? event.traceHint : null,
    requestedModel: typeof event.requestedModel === 'string' ? event.requestedModel : null,
    actualModel: typeof event.actualModel === 'string' ? event.actualModel : null,
    downstreamPath: typeof event.downstreamPath === 'string' ? event.downstreamPath : null,
    routeId: typeof event.routeId === 'number' ? event.routeId : null,
    channelId: typeof event.channelId === 'number' ? event.channelId : null,
    siteId: typeof event.siteId === 'number' ? event.siteId : null,
    siteName: typeof event.siteName === 'string' ? event.siteName : null,
    endpoint: typeof event.endpoint === 'string' ? event.endpoint : null,
    endpointPath: typeof event.endpointPath === 'string' ? event.endpointPath : null,
    status: typeof event.status === 'number' ? event.status : null,
    retryCount: typeof event.retryCount === 'number' ? event.retryCount : null,
    reason: typeof event.reason === 'string' ? event.reason : null,
    detail: event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
      ? event.detail as Record<string, unknown>
      : null,
  };
}

async function loadTraceSnapshot(force = false): Promise<void> {
  refreshContext();
  if (!force && snapshotLoaded) return;
  if (!force && traceEvents.length > 0) {
    snapshotLoaded = true;
    return;
  }
  if (snapshotLoadPromise && !force) {
    await snapshotLoadPromise;
    return;
  }
  const task = (async () => {
    try {
      const [{ eq }, { db, schema }] = await Promise.all([
        import('drizzle-orm'),
        import('../db/index.js'),
      ]);
      const row = await db.select({ value: schema.settings.value })
        .from(schema.settings)
        .where(eq(schema.settings.key, PROXY_DEBUG_TRACE_SETTING_KEY))
        .get();
      const payload = row?.value ? JSON.parse(row.value) as Record<string, unknown> : null;
      const items = Array.isArray(payload?.items) ? payload.items : [];
      traceEvents.length = 0;
      for (const item of items) {
        const normalized = normalizeTraceEvent(item);
        if (!normalized) continue;
        traceEvents.push(normalized);
      }
      trimTraceEvents();
    } catch {
      // Keep in-memory traces when persistence is unavailable.
    } finally {
      snapshotLoaded = true;
    }
  })();
  snapshotLoadPromise = task.finally(() => {
    if (snapshotLoadPromise === task) {
      snapshotLoadPromise = null;
    }
  });
  await snapshotLoadPromise;
}

export function buildProxyDebugTraceId(input: { sessionId?: string | null; traceHint?: string | null }): string | null {
  const sessionId = String(input.sessionId || '').trim();
  if (sessionId) return `session:${sessionId}`;
  const traceHint = String(input.traceHint || '').trim();
  if (traceHint) return `trace:${traceHint}`;
  return config.proxyDebugTraceEnabled ? `anon:${Date.now()}` : null;
}

export function appendProxyDebugTrace(input: Omit<ProxyDebugTraceEvent, 'at'>): void {
  refreshContext();
  if (!shouldRecordTrace(input)) return;
  const traceId = String(input.traceId || '').trim();
  if (!traceId) return;

  traceEvents.push({
    ...input,
    detail: input.detail ? normalizeTraceDetailValue(input.detail) as Record<string, unknown> : null,
    traceId,
    at: new Date().toISOString(),
  });
  trimTraceEvents();
  scheduleTraceSnapshotPersistence();
}

export async function listProxyDebugTraces(input?: {
  traceId?: string | null;
  sessionId?: string | null;
  traceHint?: string | null;
  limit?: number | null;
  kind?: string | null;
  siteId?: number | null;
}): Promise<ProxyDebugTraceEvent[]> {
  await loadTraceSnapshot();
  const traceId = String(input?.traceId || '').trim();
  const sessionId = String(input?.sessionId || '').trim();
  const traceHint = String(input?.traceHint || '').trim();
  const kind = String(input?.kind || '').trim();
  const siteId = Number.isFinite(input?.siteId as number) ? Number(input?.siteId) : 0;
  const limit = normalizeTraceLimit(input?.limit);

  const filtered = traceEvents.filter((event) => {
    if (traceId && event.traceId !== traceId) return false;
    if (sessionId && event.sessionId !== sessionId) return false;
    if (traceHint && event.traceHint !== traceHint) return false;
    if (kind && event.kind !== kind) return false;
    if (siteId > 0 && event.siteId !== siteId) return false;
    return true;
  });

  return filtered.slice(-limit);
}

export async function summarizeProxyDebugTraces(): Promise<{
  total: number;
  kinds: Record<string, number>;
  sites: Array<{ siteId: number | null; siteName: string | null; count: number }>;
}> {
  await loadTraceSnapshot();
  const kinds: Record<string, number> = {};
  const siteBuckets = new Map<string, { siteId: number | null; siteName: string | null; count: number }>();

  for (const event of traceEvents) {
    kinds[event.kind] = (kinds[event.kind] || 0) + 1;
    const key = `${event.siteId ?? 'null'}:${event.siteName ?? ''}`;
    const bucket = siteBuckets.get(key) || {
      siteId: event.siteId ?? null,
      siteName: event.siteName ?? null,
      count: 0,
    };
    bucket.count += 1;
    siteBuckets.set(key, bucket);
  }

  return {
    total: traceEvents.length,
    kinds,
    sites: [...siteBuckets.values()].sort((left, right) => right.count - left.count).slice(0, 20),
  };
}

export async function flushProxyDebugTracePersistence(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    await persistTraceSnapshot();
    return;
  }
  if (persistInFlight) {
    await persistInFlight;
  }
}

export function clearProxyDebugTraces(): void {
  refreshContext();
  traceEvents.length = 0;
  snapshotLoaded = true;
}
