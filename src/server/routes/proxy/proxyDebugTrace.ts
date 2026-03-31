import type { DownstreamClientContext } from './downstreamClientContext.js';
import { appendProxyDebugTrace, buildProxyDebugTraceId } from '../../services/proxyDebugTraceStore.js';

type SelectedLike = {
  channel?: { id?: number | null; routeId?: number | null } | null;
  site?: { id?: number | null; name?: string | null } | null;
  actualModel?: string | null;
};

export function recordProxyDebugTrace(input: {
  clientContext: DownstreamClientContext | null;
  kind: string;
  requestedModel?: string | null;
  actualModel?: string | null;
  downstreamPath?: string | null;
  selected?: SelectedLike | null;
  endpoint?: string | null;
  endpointPath?: string | null;
  status?: number | null;
  retryCount?: number | null;
  reason?: string | null;
  detail?: Record<string, unknown> | null;
}): void {
  const traceId = buildProxyDebugTraceId({
    sessionId: input.clientContext?.sessionId || null,
    traceHint: input.clientContext?.traceHint || null,
  });
  if (!traceId) return;

  appendProxyDebugTrace({
    kind: input.kind,
    traceId,
    sessionId: input.clientContext?.sessionId || null,
    traceHint: input.clientContext?.traceHint || null,
    requestedModel: input.requestedModel || null,
    actualModel: input.actualModel || input.selected?.actualModel || null,
    downstreamPath: input.downstreamPath || null,
    routeId: input.selected?.channel?.routeId ?? null,
    channelId: input.selected?.channel?.id ?? null,
    siteId: input.selected?.site?.id ?? null,
    siteName: input.selected?.site?.name ?? null,
    endpoint: input.endpoint || null,
    endpointPath: input.endpointPath || null,
    status: input.status ?? null,
    retryCount: input.retryCount ?? null,
    reason: input.reason || null,
    detail: input.detail || null,
  });
}
