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
import { withSiteProxyRequestInit, withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { getProxyUrlFromExtraConfig } from '../../services/accountExtraConfig.js';
import { cloneFormDataWithOverrides, ensureMultipartBufferParser, parseMultipartFormData } from './multipart.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { buildUpstreamUrl } from './upstreamUrl.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from './downstreamClientContext.js';
import { logProxyNoChannelFailure } from './proxyNoChannelLog.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import {
  deleteProxyVideoTaskByPublicId,
  getProxyVideoTaskByPublicId,
  refreshProxyVideoTaskSnapshot,
  saveProxyVideoTask,
} from '../../services/proxyVideoTaskStore.js';
import { createRequestBudget, shouldRetryWithinBudget, waitForRetryWithinBudget } from './requestBudget.js';
import { DefaultProxyConductor } from '../../proxy-core/conductor/DefaultProxyConductor.js';
import { recordProxyDebugTrace } from './proxyDebugTrace.js';

const MAX_RETRIES = config.proxyMaxRetries;

function rewriteVideoResponsePublicId(payload: unknown, publicId: string): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...(payload as Record<string, unknown>),
    id: publicId,
  };
}

async function executeVideoCreateRequest(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  requestedModel: string;
  downstreamPolicy: ReturnType<typeof getDownstreamRoutingPolicy>;
  downstreamApiKeyId: number | null;
  downstreamPath: string;
  clientContext: DownstreamClientContext | null;
  requestBudget: ReturnType<typeof createRequestBudget>;
  multipartForm: FormData | null;
  jsonBody: Record<string, unknown> | null;
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
    multipartForm,
    jsonBody,
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
          downstreamPolicy,
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
      recordProxyDebugTrace({
        clientContext,
        kind: 'channel_selected',
        requestedModel,
        actualModel,
        downstreamPath,
        selected,
        retryCount,
      });
      const targetUrl = buildUpstreamUrl(selected.site.url, '/v1/videos');
      const accountProxy = getProxyUrlFromExtraConfig(selected.account.extraConfig);
      const requestInit = multipartForm
        ? withSiteRecordProxyRequestInit(selected.site, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${selected.tokenValue}`,
          },
          body: cloneFormDataWithOverrides(multipartForm, {
            model: actualModel,
          }) as any,
        }, accountProxy)
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
        }, accountProxy);
      const startTime = Date.now();

      try {
        const upstream = await fetch(targetUrl, {
          ...requestInit,
          signal: AbortSignal.timeout(requestBudget.getPerAttemptTimeoutMs({ preferFastFail: true })),
        });
        const text = await upstream.text();
        if (!upstream.ok) {
          const retryAfterHeader = upstream.headers.get('retry-after');
          recordProxyDebugTrace({
            clientContext,
            kind: 'endpoint_final_failure',
            requestedModel,
            actualModel,
            downstreamPath,
            selected,
            status: upstream.status,
            retryCount,
            reason: text,
            endpointPath: '/v1/videos',
          });
          await tokenRouter.recordFailure(selected.channel.id, {
            status: upstream.status,
            errorText: text,
            modelName: actualModel,
            retryAfterHeader,
          });
          logProxy(
            selected,
            requestedModel,
            actualModel,
            'failed',
            upstream.status,
            Date.now() - startTime,
            text,
            retryCount,
            downstreamApiKeyId,
            clientContext,
            downstreamPath,
            '/v1/videos',
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
        try { data = JSON.parse(text); } catch { data = {}; }
        const upstreamVideoId = typeof data?.id === 'string' ? data.id.trim() : '';
        if (!upstreamVideoId) {
          await tokenRouter.recordFailure(selected.channel.id, {
            status: 502,
            errorText: 'Upstream video response did not include id',
            modelName: actualModel,
          });
          logProxy(
            selected,
            requestedModel,
            actualModel,
            'failed',
            502,
            Date.now() - startTime,
            'Upstream video response did not include id',
            retryCount,
            downstreamApiKeyId,
            clientContext,
            downstreamPath,
            '/v1/videos',
          );
          return {
            ok: false,
            action: 'stop',
            status: 502,
            rawErrorText: 'Upstream video response did not include id',
          };
        }

        const mapping = await saveProxyVideoTask({
          upstreamVideoId,
          siteUrl: String(selected.site.url || ''),
          tokenValue: String(selected.tokenValue || ''),
          requestedModel,
          actualModel,
          channelId: typeof selected.channel.id === 'number' ? selected.channel.id : null,
          accountId: typeof selected.account.id === 'number' ? selected.account.id : null,
          statusSnapshot: data,
          upstreamResponseMeta: {
            contentType: upstream.headers.get('content-type') || 'application/json',
          },
          lastUpstreamStatus: upstream.status,
        });

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
        recordProxyDebugTrace({
          clientContext,
          kind: 'proxy_success',
          requestedModel,
          actualModel,
          downstreamPath,
          selected,
          status: upstream.status,
          retryCount,
          endpointPath: '/v1/videos',
        });
        logProxy(
          selected,
          requestedModel,
          actualModel,
          'success',
          upstream.status,
          latency,
          null,
          retryCount,
          downstreamApiKeyId,
          clientContext,
          downstreamPath,
          '/v1/videos',
        );
        recordDownstreamCostUsage(request, estimatedCost);
        reply.code(upstream.status).send(rewriteVideoResponsePublicId(data, mapping.publicId));
        return { ok: true, response: upstream, latencyMs: latency, cost: estimatedCost };
      } catch (error: any) {
        const errorMessage = error?.message || 'network failure';
        recordProxyDebugTrace({
          clientContext,
          kind: 'proxy_exception',
          requestedModel,
          actualModel,
          downstreamPath,
          selected,
          retryCount,
          reason: errorMessage,
          endpointPath: '/v1/videos',
        });
        await tokenRouter.recordFailure(selected.channel.id, {
          status: 0,
          errorText: errorMessage,
          modelName: actualModel,
        });
        logProxy(
          selected,
          requestedModel,
          actualModel,
          'failed',
          0,
          Date.now() - startTime,
          errorMessage,
          retryCount,
          downstreamApiKeyId,
          clientContext,
          downstreamPath,
          '/v1/videos',
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
      message: finalMessage,
      type: execution.reason === 'no_channel' ? 'server_error' : 'upstream_error',
    },
  });
}

export async function videosProxyRoute(app: FastifyInstance) {
  ensureMultipartBufferParser(app);

  app.post('/v1/videos', async (request: FastifyRequest, reply: FastifyReply) => {
    const downstreamPath = '/v1/videos';
    const multipartForm = await parseMultipartFormData(request);
    const jsonBody = (!multipartForm && request.body && typeof request.body === 'object')
      ? request.body as Record<string, unknown>
      : null;
    const requestedModel = typeof multipartForm?.get('model') === 'string'
      ? String(multipartForm.get('model')).trim()
      : (typeof jsonBody?.model === 'string' ? jsonBody.model.trim() : '');

    if (!requestedModel) {
      return reply.code(400).send({
        error: { message: 'model is required', type: 'invalid_request_error' },
      });
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;

    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body: jsonBody || {},
    });
    const requestBudget = createRequestBudget();
    return await executeVideoCreateRequest({
      request,
      reply,
      requestedModel,
      downstreamPolicy,
      downstreamApiKeyId,
      downstreamPath,
      clientContext,
      requestBudget,
      multipartForm,
      jsonBody,
    });
  });

  app.get('/v1/videos/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const downstreamPath = '/v1/videos/:id';
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body: {},
    });
    const mapping = await getProxyVideoTaskByPublicId(request.params.id);
    if (!mapping) {
      return reply.code(404).send({
        error: { message: 'Video task not found', type: 'not_found_error' },
      });
    }

    const targetUrl = buildUpstreamUrl(mapping.siteUrl, `/v1/videos/${encodeURIComponent(mapping.upstreamVideoId)}`);
    const startTime = Date.now();

    try {
      const upstream = await fetch(targetUrl, await withSiteProxyRequestInit(targetUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${mapping.tokenValue}`,
        },
      }));
      const text = await upstream.text();
      const latency = Date.now() - startTime;

      logProxy(
        {
          channel: { id: mapping.channelId, routeId: null },
          account: { id: mapping.accountId },
        },
        mapping.requestedModel || mapping.actualModel || 'videos',
        mapping.actualModel || mapping.requestedModel || 'videos',
        upstream.ok ? 'success' : 'failed',
        upstream.status,
        latency,
        upstream.ok ? null : text,
        0,
        downstreamApiKeyId,
        clientContext,
        downstreamPath,
        '/v1/videos/:id',
      );

      try {
        const data = JSON.parse(text);
        await refreshProxyVideoTaskSnapshot(mapping.publicId, {
          statusSnapshot: data,
          upstreamResponseMeta: {
            contentType: upstream.headers.get('content-type') || 'application/json',
          },
          lastUpstreamStatus: upstream.status,
        });
        return reply.code(upstream.status).send(rewriteVideoResponsePublicId(data, mapping.publicId));
      } catch {
        return reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      }
    } catch (error: any) {
      logProxy(
        {
          channel: { id: mapping.channelId, routeId: null },
          account: { id: mapping.accountId },
        },
        mapping.requestedModel || mapping.actualModel || 'videos',
        mapping.actualModel || mapping.requestedModel || 'videos',
        'failed',
        0,
        Date.now() - startTime,
        error?.message || 'network failure',
        0,
        downstreamApiKeyId,
        clientContext,
        downstreamPath,
        '/v1/videos/:id',
      );
      return reply.code(502).send({
        error: { message: error?.message || 'network failure', type: 'upstream_error' },
      });
    }
  });

  app.delete('/v1/videos/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const downstreamPath = '/v1/videos/:id';
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body: {},
    });
    const mapping = await getProxyVideoTaskByPublicId(request.params.id);
    if (!mapping) {
      return reply.code(404).send({
        error: { message: 'Video task not found', type: 'not_found_error' },
      });
    }

    const targetUrl = buildUpstreamUrl(mapping.siteUrl, `/v1/videos/${encodeURIComponent(mapping.upstreamVideoId)}`);
    const startTime = Date.now();
    try {
      const upstream = await fetch(targetUrl, await withSiteProxyRequestInit(targetUrl, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${mapping.tokenValue}`,
        },
      }));
      const latency = Date.now() - startTime;

      if (upstream.ok) {
        await deleteProxyVideoTaskByPublicId(mapping.publicId);
        logProxy(
          {
            channel: { id: mapping.channelId, routeId: null },
            account: { id: mapping.accountId },
          },
          mapping.requestedModel || mapping.actualModel || 'videos',
          mapping.actualModel || mapping.requestedModel || 'videos',
          'success',
          upstream.status,
          latency,
          null,
          0,
          downstreamApiKeyId,
          clientContext,
          downstreamPath,
          '/v1/videos/:id',
        );
        return reply.code(upstream.status).send();
      }

      const text = await upstream.text();
      logProxy(
        {
          channel: { id: mapping.channelId, routeId: null },
          account: { id: mapping.accountId },
        },
        mapping.requestedModel || mapping.actualModel || 'videos',
        mapping.actualModel || mapping.requestedModel || 'videos',
        'failed',
        upstream.status,
        latency,
        text || 'Upstream delete failed',
        0,
        downstreamApiKeyId,
        clientContext,
        downstreamPath,
        '/v1/videos/:id',
      );
      return reply.code(upstream.status).send({
        error: { message: text || 'Upstream delete failed', type: 'upstream_error' },
      });
    } catch (error: any) {
      logProxy(
        {
          channel: { id: mapping.channelId, routeId: null },
          account: { id: mapping.accountId },
        },
        mapping.requestedModel || mapping.actualModel || 'videos',
        mapping.actualModel || mapping.requestedModel || 'videos',
        'failed',
        0,
        Date.now() - startTime,
        error?.message || 'network failure',
        0,
        downstreamApiKeyId,
        clientContext,
        downstreamPath,
        '/v1/videos/:id',
      );
      return reply.code(502).send({
        error: { message: error?.message || 'network failure', type: 'upstream_error' },
      });
    }
  });
}

function logProxy(
  selected: any,
  modelRequested: string,
  modelActual: string,
  status: string,
  httpStatus: number,
  latencyMs: number,
  errorMessage: string | null,
  retryCount: number,
  downstreamApiKeyId: number | null,
  clientContext: DownstreamClientContext | null,
  downstreamPath: string,
  upstreamPath: string,
) {
  void insertProxyLog({
    routeId: typeof selected?.channel?.routeId === 'number' ? selected.channel.routeId : null,
    channelId: typeof selected?.channel?.id === 'number' ? selected.channel.id : null,
    accountId: typeof selected?.account?.id === 'number' ? selected.account.id : null,
    downstreamApiKeyId,
    modelRequested,
    modelActual,
    status,
    httpStatus,
    latencyMs,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    errorMessage: composeProxyLogMessage({
      clientKind: clientContext?.clientKind && clientContext.clientKind !== 'generic'
        ? clientContext.clientKind
        : null,
      sessionId: clientContext?.sessionId || null,
      traceHint: clientContext?.traceHint || null,
      downstreamPath,
      upstreamPath,
      errorMessage,
    }),
    clientFamily: clientContext?.clientKind || null,
    clientAppId: clientContext?.clientAppId || null,
    clientAppName: clientContext?.clientAppName || null,
    clientConfidence: clientContext?.clientConfidence || null,
    retryCount,
    createdAt: formatUtcSqlDateTime(new Date()),
  }).catch((error) => {
    console.warn('[proxy/videos] failed to write proxy log', error);
  });
}
