import type { FastifyReply, FastifyRequest } from 'fastify';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { getDefaultGlobalPolicy, isModelAllowedByPolicyOrAllowedRoutes, recordManagedKeyCostUsage } from '../../services/downstreamApiKeyService.js';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY, type DownstreamRoutingPolicy } from '../../services/downstreamPolicyTypes.js';
import { detectDownstreamClientContext } from './downstreamClientContext.js';
import { getTesterForcedChannelId } from '../../proxy-core/channelSelection.js';

function normalizeStickyPart(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 160);
}

function buildStickySessionKey(request: FastifyRequest): string | null {
  const authContext = getProxyAuthContext(request);
  if (!authContext) return null;

  const downstreamPath = typeof request.url === 'string'
    ? request.url.split('?')[0]?.trim() || '/'
    : '/';
  const clientContext = detectDownstreamClientContext({
    downstreamPath,
    headers: request.headers as Record<string, unknown>,
    body: request.body,
  });

  const stickyIdentity = normalizeStickyPart(
    clientContext.previousResponseId
    || clientContext.promptCacheKey
    || clientContext.sessionId
    || clientContext.traceHint,
  );
  if (!stickyIdentity) return null;

  const ownerPrefix = authContext.source === 'managed'
    ? `mk:${authContext.keyId ?? authContext.token}`
    : `global:${authContext.keyName || 'default'}`;
  return `${ownerPrefix}:${downstreamPath}:${stickyIdentity}`;
}

export function getDownstreamRoutingPolicy(request: FastifyRequest): DownstreamRoutingPolicy {
  const authContext = getProxyAuthContext(request);
  if (!authContext) {
    return {
      ...EMPTY_DOWNSTREAM_ROUTING_POLICY,
      publicRoutesOnly: true,
    };
  }
  const basePolicy = authContext.source === 'global'
    ? getDefaultGlobalPolicy()
    : authContext.policy;

  const forcedChannelId = getTesterForcedChannelId({
    headers: request.headers as Record<string, unknown>,
    clientIp: request.ip,
  });

  return {
    ...basePolicy,
    stickySessionKey: buildStickySessionKey(request),
    forcedChannelId,
    publicRoutesOnly: true,
  };
}

export async function ensureModelAllowedForDownstreamKey(
  request: FastifyRequest,
  reply: FastifyReply,
  requestedModel: string,
): Promise<boolean> {
  const authContext = getProxyAuthContext(request);
  if (!authContext) return true;

  if (await isModelAllowedByPolicyOrAllowedRoutes(requestedModel, authContext.policy)) {
    return true;
  }

  reply.code(403).send({
    error: {
      message: `Model not allowed for this API key: ${requestedModel}`,
      type: 'permission_error',
    },
  });
  return false;
}

export function recordDownstreamCostUsage(request: FastifyRequest, estimatedCost: number): void {
  const authContext = getProxyAuthContext(request);
  if (!authContext || authContext.keyId === null) return;
  void recordManagedKeyCostUsage(authContext.keyId, estimatedCost);
}
