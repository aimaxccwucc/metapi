import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutesOnDemand } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { estimateProxyCost } from '../../services/modelPricingService.js';
import { shouldAvoidSiteForRequest, shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import { withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { getProxyUrlFromExtraConfig } from '../../services/accountExtraConfig.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { cloneFormDataWithOverrides, ensureMultipartBufferParser, parseMultipartFormData } from './multipart.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { buildUpstreamUrl } from './upstreamUrl.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from './downstreamClientContext.js';
import { logProxyNoChannelFailure } from './proxyNoChannelLog.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { markTokenModelUnavailable } from '../../services/mediaRoutingSupport.js';
import { createRequestBudget, shouldRetryWithinBudget, waitForRetryWithinBudget } from './requestBudget.js';
import { DefaultProxyConductor } from '../../proxy-core/conductor/DefaultProxyConductor.js';

const MAX_RETRIES = config.proxyMaxRetries;

function shouldMarkImageModelUnavailable(status: number, errorText: string): boolean {
  if (status <= 0) return false;
  const normalized = String(errorText || '').toLowerCase();
  if (!normalized) return false;
  if (/not supported model for image generation/.test(normalized)) return true;
  if (/only imagen models are supported/.test(normalized)) return true;
  if (/unsupported\s+model/.test(normalized)) return true;
  if (/model\s+not\s+supported/.test(normalized)) return true;
  if (/does\s+not\s+support(?:\s+the)?\s+model/.test(normalized)) return true;
  return false;
}

async function executeImageProxyRequest(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  requestedModel: string;
  downstreamPolicy: ReturnType<typeof getDownstreamRoutingPolicy>;
  downstreamApiKeyId: number | null;
  downstreamPath: string;
  clientContext: DownstreamClientContext | null;
  requestBudget: ReturnType<typeof createRequestBudget>;
  buildRequest: (selected: any, actualModel: string) => Promise<{ targetUrl: string; requestInit: any }> | { targetUrl: string; requestInit: any };
}) {
  const {
    request,
    reply,
    requestedModel,
    downstreamPolicy,
    downstreamApiKeyId,
    downstreamPath,
    clientContext,
    requestBudget,
    buildRequest,
  } = params;
  let reportedNoChannel = false;

  const conductor = new DefaultProxyConductor({
    selectChannel: (model, policy) => tokenRouter.selectChannel(model, policy as any),
    selectNextChannel: (model, excludeChannelIds, policy, excludeSiteIds) => tokenRouter.selectNextChannel(
      model,
      excludeChannelIds,
      policy as any,
      excludeSiteIds,
    ),
  });

  const execution = await conductor.execute({
    requestedModel,
    downstreamPolicy,
    maxAttempts: MAX_RETRIES + 1,
    refreshSelection: async () => {
      await refreshModelsAndRebuildRoutesOnDemand();
      return await tokenRouter.selectChannel(requestedModel, downstreamPolicy);
    },
    onNoChannel: async ({ attempts }) => {
      reportedNoChannel = true;
      await reportProxyAllFailed({
        model: requestedModel,
        reason: 'No available channels after retries',
      });
      if (attempts === 0) {
        await logProxyNoChannelFailure({
          modelRequested: requestedModel,
          httpStatus: 503,
          errorMessage: 'No available channels for this model',
          retryCount: 0,
          downstreamPath,
          clientContext,
          downstreamApiKeyId,
        });
      }
    },
    getFailoverSiteId: (selected, failure) => {
      if (!shouldAvoidSiteForRequest(
        typeof failure.status === 'number' ? failure.status : 0,
        typeof failure.rawErrorText === 'string' ? failure.rawErrorText : undefined,
      )) return null;
      const siteId = Number((selected.site as { id?: unknown }).id);
      return Number.isFinite(siteId) ? Math.trunc(siteId) : null;
    },
    attempt: async ({ selected, attemptIndex }) => {
      const retryCount = attemptIndex;
      if (requestBudget.isExpired()) {
        return {
          ok: false,
          action: 'stop',
          status: 504,
          rawErrorText: requestBudget.buildTimeoutMessage(),
        };
      }

      const actualModel = selected.actualModel || requestedModel;
      const { targetUrl, requestInit } = await buildRequest(selected, actualModel);
      const startTime = Date.now();

      try {
        const upstream = await fetch(targetUrl, {
          ...requestInit,
          signal: AbortSignal.timeout(requestBudget.getPerAttemptTimeoutMs({ preferFastFail: true })),
        });
        const text = await upstream.text();
        if (!upstream.ok) {
          const retryAfterHeader = upstream.headers.get('retry-after');
          await tokenRouter.recordFailure(selected.channel.id, {
            status: upstream.status,
            errorText: text,
            modelName: selected.actualModel,
            retryAfterHeader,
          });
          if (shouldMarkImageModelUnavailable(upstream.status, text)) {
            await markTokenModelUnavailable(selected.token?.id, actualModel);
          }
          logProxy(
            selected,
            requestedModel,
            'failed',
            upstream.status,
            Date.now() - startTime,
            text,
            retryCount,
            downstreamApiKeyId,
            0,
            downstreamPath,
            clientContext,
          );
          if (isTokenExpiredError({ status: upstream.status, message: text })) {
            await reportTokenExpired({
              accountId: selected.account.id,
              username: selected.account.username,
              siteName: selected.site.name,
              detail: `HTTP ${upstream.status}`,
            });
          }
          if (
            shouldRetryProxyRequest(upstream.status, text)
            && await waitForRetryWithinBudget({
              retryCount,
              maxRetries: MAX_RETRIES,
              budget: requestBudget,
              status: upstream.status,
              retryAfterHeader,
            })
          ) {
            return {
              ok: false,
              action: 'failover',
              status: upstream.status,
              rawErrorText: text,
              retryAfterHeader,
            };
          }
          return {
            ok: false,
            action: 'stop',
            status: upstream.status,
            rawErrorText: text,
            retryAfterHeader,
          };
        }

        let data: any = {};
        try { data = JSON.parse(text); } catch { data = { data: [] }; }

        const latency = Date.now() - startTime;
        const estimatedCost = await estimateProxyCost({
          site: selected.site,
          account: selected.account,
          modelName: actualModel,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        });
        await tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, selected.actualModel);
        recordDownstreamCostUsage(request, estimatedCost);
        logProxy(selected, requestedModel, 'success', upstream.status, latency, null, retryCount, downstreamApiKeyId, estimatedCost, downstreamPath, clientContext);
        reply.code(upstream.status).send(data);
        return { ok: true, response: upstream, latencyMs: latency, cost: estimatedCost };
      } catch (err: any) {
        const errorMessage = err?.message || 'network failure';
        await tokenRouter.recordFailure(selected.channel.id, {
          status: 0,
          errorText: errorMessage,
          modelName: selected.actualModel,
        });
        logProxy(
          selected,
          requestedModel,
          'failed',
          0,
          Date.now() - startTime,
          errorMessage,
          retryCount,
          downstreamApiKeyId,
          0,
          downstreamPath,
          clientContext,
        );
        if (await waitForRetryWithinBudget({
          retryCount,
          maxRetries: MAX_RETRIES,
          budget: requestBudget,
          status: 0,
        })) {
          return {
            ok: false,
            action: 'failover',
            status: 502,
            rawErrorText: errorMessage,
          };
        }
        return {
          ok: false,
          action: 'stop',
          status: 502,
          rawErrorText: errorMessage,
        };
      }
    },
  });

  if (execution.ok) {
    return;
  }

  const finalStatus = execution.reason === 'no_channel'
    ? 503
    : (execution.status ?? 502);
  const finalMessage = execution.reason === 'no_channel'
    ? 'No available channels for this model'
    : (execution.rawErrorText || 'upstream request failed');

  if (!reportedNoChannel) {
    await reportProxyAllFailed({
      model: requestedModel,
      reason: finalStatus === 504 ? requestBudget.buildTimeoutMessage() : finalMessage,
    });
  }

  return reply.code(finalStatus).send({
    error: {
      message: finalStatus === 502 ? `Upstream error: ${finalMessage}` : finalMessage,
      type: execution.reason === 'no_channel' ? 'server_error' : 'upstream_error',
    },
  });
}

export async function imagesProxyRoute(app: FastifyInstance) {
  ensureMultipartBufferParser(app);

  app.post('/v1/images/generations', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const requestedModel = body?.model || 'gpt-image-1';
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/images/generations';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });
    const requestBudget = createRequestBudget();
    return await executeImageProxyRequest({
      request,
      reply,
      requestedModel,
      downstreamPolicy,
      downstreamApiKeyId,
      downstreamPath,
      clientContext,
      requestBudget,
      buildRequest: (selected, actualModel) => ({
        targetUrl: buildUpstreamUrl(selected.site.url, '/v1/images/generations'),
        requestInit: withSiteRecordProxyRequestInit(selected.site, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${selected.tokenValue}`,
          },
          body: JSON.stringify({ ...body, model: actualModel }),
        }, getProxyUrlFromExtraConfig(selected.account.extraConfig)),
      }),
    });
  });

  app.post('/v1/images/edits', async (request: FastifyRequest, reply: FastifyReply) => {
    const multipartForm = await parseMultipartFormData(request);
    const jsonBody = (!multipartForm && request.body && typeof request.body === 'object')
      ? request.body as Record<string, unknown>
      : null;
    const requestedModel = typeof multipartForm?.get('model') === 'string'
      ? String(multipartForm.get('model')).trim()
      : (typeof jsonBody?.model === 'string' ? jsonBody.model.trim() : '') || 'gpt-image-1';

    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/images/edits';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body: jsonBody || Object.fromEntries(multipartForm?.entries?.() || []),
    });
    const requestBudget = createRequestBudget();
    return await executeImageProxyRequest({
      request,
      reply,
      requestedModel,
      downstreamPolicy,
      downstreamApiKeyId,
      downstreamPath,
      clientContext,
      requestBudget,
      buildRequest: (selected, actualModel) => ({
        targetUrl: buildUpstreamUrl(selected.site.url, '/v1/images/edits'),
        requestInit: multipartForm
          ? withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${selected.tokenValue}`,
            },
            body: cloneFormDataWithOverrides(multipartForm, {
              model: actualModel,
            }) as any,
          }, getProxyUrlFromExtraConfig(selected.account.extraConfig))
          : withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${selected.tokenValue}`,
            },
            body: JSON.stringify({
              ...(jsonBody || {}),
              model: actualModel,
            }),
          }, getProxyUrlFromExtraConfig(selected.account.extraConfig)),
      }),
    });
  });

  app.post('/v1/images/variations', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(400).send({
      error: {
        message: 'Image variations are not supported',
        type: 'invalid_request_error',
      },
    });
  });
}

async function logProxy(
  selected: any,
  modelRequested: string,
  status: string,
  httpStatus: number,
  latencyMs: number,
  errorMessage: string | null,
  retryCount: number,
  downstreamApiKeyId: number | null = null,
  estimatedCost = 0,
  downstreamPath = '/v1/images/generations',
  clientContext: DownstreamClientContext | null = null,
) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    const normalizedErrorMessage = composeProxyLogMessage({
      clientKind: clientContext?.clientKind && clientContext.clientKind !== 'generic'
        ? clientContext.clientKind
        : null,
      sessionId: clientContext?.sessionId || null,
      traceHint: clientContext?.traceHint || null,
      downstreamPath,
      errorMessage,
    });
    await insertProxyLog({
      routeId: selected.channel.routeId,
      channelId: selected.channel.id,
      accountId: selected.account.id,
      downstreamApiKeyId,
      modelRequested,
      modelActual: selected.actualModel,
      status,
      httpStatus,
      latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost,
      clientFamily: clientContext?.clientKind || null,
      clientAppId: clientContext?.clientAppId || null,
      clientAppName: clientContext?.clientAppName || null,
      clientConfidence: clientContext?.clientConfidence || null,
      errorMessage: normalizedErrorMessage,
      retryCount,
      createdAt,
    });
  } catch (error) {
    console.warn('[proxy/images] failed to write proxy log', error);
  }
}

