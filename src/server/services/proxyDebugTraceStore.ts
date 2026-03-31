import { config } from '../config.js';

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
