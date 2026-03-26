import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { estimateProxyCost } from '../../services/modelPricingService.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import { withSiteProxyRequestInit, withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { getProxyUrlFromExtraConfig } from '../../services/accountExtraConfig.js';
import { cloneFormDataWithOverrides, ensureMultipartBufferParser, parseMultipartFormData } from './multipart.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { buildUpstreamUrl } from './upstreamUrl.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from './downstreamClientContext.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import {
  deleteProxyVideoTaskByPublicId,
  getProxyVideoTaskByPublicId,
  refreshProxyVideoTaskSnapshot,
  saveProxyVideoTask,
} from '../../services/proxyVideoTaskStore.js';

const MAX_RETRIES = 2;

function rewriteVideoResponsePublicId(payload: unknown, publicId: string): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...(payload as Record<string, unknown>),
    id: publicId,
  };
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
    const excludeChannelIds: number[] = [];
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      let selected = retryCount === 0
        ? await tokenRouter.selectChannel(requestedModel, downstreamPolicy)
        : await tokenRouter.selectNextChannel(requestedModel, excludeChannelIds, downstreamPolicy);

      if (!selected && retryCount === 0) {
        await refreshModelsAndRebuildRoutes();
        selected = await tokenRouter.selectChannel(requestedModel, downstreamPolicy);
      }

      if (!selected) {
        await reportProxyAllFailed({
          model: requestedModel,
          reason: 'No available channels after retries',
        });
        return reply.code(503).send({
          error: { message: 'No available channels for this model', type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);
      const targetUrl = buildUpstreamUrl(selected.site.url, '/v1/videos');
      const startTime = Date.now();

      try {
        const actualModel = selected.actualModel || requestedModel;
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

        const upstream = await fetch(targetUrl, requestInit);
        const text = await upstream.text();
        if (!upstream.ok) {
          await tokenRouter.recordFailure(selected.channel.id, {
            status: upstream.status,
            errorText: text,
            modelName: actualModel,
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
          if (shouldRetryProxyRequest(upstream.status, text) && retryCount < MAX_RETRIES) {
            retryCount += 1;
            continue;
          }
          await reportProxyAllFailed({
            model: requestedModel,
            reason: `upstream returned HTTP ${upstream.status}`,
          });
          return reply.code(upstream.status).send({ error: { message: text, type: 'upstream_error' } });
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
          return reply.code(502).send({
            error: { message: 'Upstream video response did not include id', type: 'upstream_error' },
          });
        }

        const mapping = await saveProxyVideoTask({
          upstreamVideoId,
          siteUrl: selected.site.url,
          tokenValue: selected.tokenValue,
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
        return reply.code(upstream.status).send(rewriteVideoResponsePublicId(data, mapping.publicId));
      } catch (error: any) {
        const actualModel = selected.actualModel || requestedModel;
        await tokenRouter.recordFailure(selected.channel.id, {
          status: 0,
          errorText: error?.message || 'network failure',
          modelName: actualModel,
        });
        logProxy(
          selected,
          requestedModel,
          actualModel,
          'failed',
          0,
          Date.now() - startTime,
          error?.message || 'network failure',
          retryCount,
          downstreamApiKeyId,
          clientContext,
          downstreamPath,
          '/v1/videos',
        );
        if (retryCount < MAX_RETRIES) {
          retryCount += 1;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: error?.message || 'network failure',
        });
        return reply.code(502).send({
          error: { message: error?.message || 'network failure', type: 'upstream_error' },
        });
      }
    }
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
