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

export function buildProxyDebugTraceId(input: { sessionId?: string | null; traceHint?: string | null }): string | null {
  const sessionId = String(input.sessionId || '').trim();
  if (sessionId) return `session:${sessionId}`;
  const traceHint = String(input.traceHint || '').trim();
  if (traceHint) return `trace:${traceHint}`;
  return config.proxyDebugTraceEnabled ? `anon:${Date.now()}` : null;
}

export function appendProxyDebugTrace(input: Omit<ProxyDebugTraceEvent, 'at'>): void {
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
}

export function listProxyDebugTraces(input?: {
  traceId?: string | null;
  sessionId?: string | null;
  traceHint?: string | null;
  limit?: number | null;
}): ProxyDebugTraceEvent[] {
  const traceId = String(input?.traceId || '').trim();
  const sessionId = String(input?.sessionId || '').trim();
  const traceHint = String(input?.traceHint || '').trim();
  const limit = normalizeTraceLimit(input?.limit);

  const filtered = traceEvents.filter((event) => {
    if (traceId && event.traceId !== traceId) return false;
    if (sessionId && event.sessionId !== sessionId) return false;
    if (traceHint && event.traceHint !== traceHint) return false;
    return true;
  });

  return filtered.slice(-limit);
}

export function clearProxyDebugTraces(): void {
  traceEvents.length = 0;
}
