import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutesOnDemand } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldAvoidSiteForRequest, shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import { withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { getProxyUrlFromExtraConfig } from '../../services/accountExtraConfig.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { buildUpstreamUrl } from './upstreamUrl.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from './downstreamClientContext.js';
import { logProxyNoChannelFailure } from './proxyNoChannelLog.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { createRequestBudget, shouldRetryWithinBudget, waitForRetryWithinBudget } from './requestBudget.js';
import { DefaultProxyConductor } from '../../proxy-core/conductor/DefaultProxyConductor.js';

const MAX_RETRIES = config.proxyMaxRetries;
const DEFAULT_SEARCH_MODEL = '__search';
const DEFAULT_MAX_RESULTS = 10;
const MAX_MAX_RESULTS = 20;

export async function searchProxyRoute(app: FastifyInstance) {
  app.post('/v1/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) {
      return reply.code(400).send({
        error: { message: 'query is required', type: 'invalid_request_error' },
      });
    }
    if (body.stream === true) {
      return reply.code(400).send({
        error: { message: 'search does not support streaming', type: 'invalid_request_error' },
      });
    }
    const rawMaxResults = body.max_results;
    const maxResults = rawMaxResults == null
      ? DEFAULT_MAX_RESULTS
      : (typeof rawMaxResults === 'number' && Number.isInteger(rawMaxResults)
        ? rawMaxResults
        : NaN);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_MAX_RESULTS) {
      return reply.code(400).send({
        error: {
          message: `max_results must be an integer between 1 and ${MAX_MAX_RESULTS}`,
          type: 'invalid_request_error',
        },
      });
    }

    const requestedModel = typeof body.model === 'string' && body.model.trim().length > 0
      ? body.model.trim()
      : DEFAULT_SEARCH_MODEL;

    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/search';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });
    const requestBudget = createRequestBudget();
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

        const targetUrl = buildUpstreamUrl(selected.site.url, '/v1/search');
        const forwardBody = {
          ...body,
          max_results: maxResults,
          model: selected.actualModel || requestedModel,
        };
        const startTime = Date.now();

        try {
          const upstream = await fetch(targetUrl, withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${selected.tokenValue}`,
            },
            body: JSON.stringify(forwardBody),
            signal: AbortSignal.timeout(requestBudget.getPerAttemptTimeoutMs({ preferFastFail: true })),
          }, getProxyUrlFromExtraConfig(selected.account.extraConfig)));

          const text = await upstream.text();
          if (!upstream.ok) {
            const retryAfterHeader = upstream.headers.get('retry-after');
            await tokenRouter.recordFailure(selected.channel.id, {
              status: upstream.status,
              errorText: text,
              modelName: selected.actualModel,
              retryAfterHeader,
            });
            logProxy(
              selected,
              requestedModel,
              'failed',
              upstream.status,
              Date.now() - startTime,
              text,
              retryCount,
              downstreamApiKeyId,
              clientContext,
              downstreamPath,
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
          await tokenRouter.recordSuccess(selected.channel.id, latency, 0, selected.actualModel);
          recordDownstreamCostUsage(request, 0);
          logProxy(selected, requestedModel, 'success', upstream.status, latency, null, retryCount, downstreamApiKeyId, clientContext, downstreamPath);
          reply.code(upstream.status).send(data);
          return { ok: true, response: upstream, latencyMs: latency, cost: 0 };
        } catch (error: any) {
          const errorMessage = error?.message || 'network error';
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
            clientContext,
            downstreamPath,
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
  clientContext: DownstreamClientContext | null = null,
  downstreamPath = '/v1/search',
) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
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
      estimatedCost: 0,
      errorMessage: composeProxyLogMessage({
        clientKind: clientContext?.clientKind && clientContext.clientKind !== 'generic'
          ? clientContext.clientKind
          : null,
        sessionId: clientContext?.sessionId || null,
        traceHint: clientContext?.traceHint || null,
        downstreamPath,
        errorMessage,
      }),
      clientFamily: clientContext?.clientKind || null,
      clientAppId: clientContext?.clientAppId || null,
      clientAppName: clientContext?.clientAppName || null,
      clientConfidence: clientContext?.clientConfidence || null,
      retryCount,
      createdAt,
    });
  } catch (error) {
    console.warn('[proxy/search] failed to write proxy log', error);
  }
}
