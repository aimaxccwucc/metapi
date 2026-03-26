import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import type { DownstreamClientContext } from './downstreamClientContext.js';
import { composeProxyLogMessage } from './logPathMeta.js';

export async function logProxyNoChannelFailure(input: {
  modelRequested: string;
  httpStatus: number;
  errorMessage: string;
  retryCount: number;
  downstreamPath: string;
  upstreamPath?: string | null;
  clientContext?: DownstreamClientContext | null;
  downstreamApiKeyId?: number | null;
}): Promise<void> {
  try {
    await insertProxyLog({
      routeId: null,
      channelId: null,
      accountId: null,
      downstreamApiKeyId: input.downstreamApiKeyId ?? null,
      modelRequested: input.modelRequested,
      modelActual: null,
      status: 'failed',
      httpStatus: input.httpStatus,
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      clientFamily: input.clientContext?.clientKind || null,
      clientAppId: input.clientContext?.clientAppId || null,
      clientAppName: input.clientContext?.clientAppName || null,
      clientConfidence: input.clientContext?.clientConfidence || null,
      errorMessage: composeProxyLogMessage({
        clientKind: input.clientContext?.clientKind && input.clientContext.clientKind !== 'generic'
          ? input.clientContext.clientKind
          : null,
        sessionId: input.clientContext?.sessionId || null,
        traceHint: input.clientContext?.traceHint || null,
        downstreamPath: input.downstreamPath,
        upstreamPath: input.upstreamPath || null,
        errorMessage: input.errorMessage,
      }),
      retryCount: input.retryCount,
      createdAt: formatUtcSqlDateTime(new Date()),
    });
  } catch (error) {
    console.warn('[proxy] failed to write no-channel proxy log', error);
  }
}
