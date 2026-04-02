import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutesOnDemand } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldAvoidSiteForRequest, shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage, pullSseDataEvents } from '../../services/proxyUsageParser.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import { withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { getProxyUrlFromExtraConfig } from '../../services/accountExtraConfig.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { detectProxyFailure } from './proxyFailureJudge.js';
import { resolveProxyLogBilling } from './proxyBilling.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { buildUpstreamUrl } from './upstreamUrl.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from './downstreamClientContext.js';
import { logProxyNoChannelFailure } from './proxyNoChannelLog.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { createRequestBudget, shouldRetryWithinBudget, waitForRetryWithinBudget } from './requestBudget.js';
import { wrapReaderWithIdleTimeout } from './streamTimeout.js';
import {
  buildCacheKey,
  buildRouteScope,
  getInflightResponseCacheWrite,
  lookupResponseCache,
  lookupStaleResponseCache,
  recordResponseCacheMiss,
  reserveInflightResponseCacheWrite,
  writeResponseCache,
} from '../../services/responseCacheService.js';
import { DefaultProxyConductor } from '../../proxy-core/conductor/DefaultProxyConductor.js';

const MAX_RETRIES = config.proxyMaxRetries;

export async function completionsProxyRoute(app: FastifyInstance) {
  app.post('/v1/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const requestedModel = body?.model;
    if (!requestedModel) {
      return reply.code(400).send({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;

    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/completions';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });
    const isStream = body.stream === true;

    const conductor = new DefaultProxyConductor({
      selectChannel: (model, policy) => tokenRouter.selectChannel(model, policy as any),
      previewSelectedChannel: typeof (tokenRouter as { previewSelectedChannel?: unknown }).previewSelectedChannel === 'function'
        ? (model, policy) => tokenRouter.previewSelectedChannel(model, policy as any)
        : undefined,
      selectNextChannel: (model, excludeChannelIds, policy, excludeSiteIds) => tokenRouter.selectNextChannel(
        model,
        excludeChannelIds,
        policy as any,
        excludeSiteIds,
      ),
    });

    const previewSelected = !isStream
      ? await conductor.previewSelectedChannel(requestedModel, downstreamPolicy)
      : null;
    const routeScope = previewSelected
      ? buildRouteScope({
          routeId: previewSelected.channel.routeId,
          siteId: previewSelected.site.id,
          actualModel: previewSelected.actualModel || requestedModel,
        })
      : null;
    const responseCacheKey = !isStream
      ? buildCacheKey({
          surface: 'completions',
          model: requestedModel,
          messages: body?.prompt,
          temperature: body?.temperature as number | null | undefined,
          top_p: body?.top_p as number | null | undefined,
          max_tokens: body?.max_tokens as number | null | undefined,
          stop: body?.stop,
          seed: body?.seed,
          routeScope,
          requestFingerprint: body,
        })
      : null;

    let inflightReservation: ReturnType<typeof reserveInflightResponseCacheWrite> | null = null;
    if (responseCacheKey) {
      const cached = await lookupResponseCache(responseCacheKey);
      if (cached) {
        await logProxy({
          channel: { routeId: null, id: null } as any,
          account: { id: null } as any,
          actualModel: requestedModel,
          site: { name: 'cache', url: '', platform: 'cache' } as any,
          tokenName: 'response_cache',
        }, requestedModel, 'success', 200, 0, null, 0, downstreamApiKeyId, cached.promptTokens, cached.completionTokens, cached.promptTokens + cached.completionTokens, 0, null, clientContext, downstreamPath, { cacheStatus: 'hit', cacheSavedCost: cached.estimatedCost });
        return reply.header('X-Cache', 'HIT').send(JSON.parse(cached.body));
      }
      const inflight = getInflightResponseCacheWrite(responseCacheKey);
      if (inflight) {
        const awaited = await inflight;
      const awaitedResponse = awaited.response;
        await logProxy({
          channel: { routeId: null, id: null } as any,
          account: { id: null } as any,
          actualModel: requestedModel,
          site: { name: 'cache', url: '', platform: 'cache' } as any,
          tokenName: 'response_cache',
        }, requestedModel, 'success', 200, 0, 'response cache inflight join', 0, downstreamApiKeyId, awaitedResponse.promptTokens, awaitedResponse.completionTokens, awaitedResponse.promptTokens + awaitedResponse.completionTokens, 0, null, clientContext, downstreamPath, { cacheStatus: awaited.cacheStatus, cacheSavedCost: awaitedResponse.estimatedCost });
        return reply.header('X-Cache', awaited.cacheStatus === 'stale' ? 'STALE' : 'HIT').send(JSON.parse(awaitedResponse.body));
      }
      inflightReservation = reserveInflightResponseCacheWrite(responseCacheKey);
      recordResponseCacheMiss();
    }

    const requestBudget = createRequestBudget();
    let reportedNoChannel = false;

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

        const targetUrl = buildUpstreamUrl(selected.site.url, '/v1/completions');
        const forwardBody = { ...body, model: selected.actualModel };
        const startTime = Date.now();

        try {
          const upstream = await fetch(targetUrl, withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${selected.tokenValue}`,
            },
            body: JSON.stringify(forwardBody),
            signal: AbortSignal.timeout(requestBudget.getPerAttemptTimeoutMs({ preferFastFail: true })),
          }, getProxyUrlFromExtraConfig((selected.account as { extraConfig?: string | null | undefined }).extraConfig)));

          if (!upstream.ok) {
            const errText = await upstream.text().catch(() => 'unknown error');
            await tokenRouter.recordFailure(selected.channel.id, {
              status: upstream.status,
              errorText: errText,
              modelName: selected.actualModel,
            });
            logProxy(
              selected,
              requestedModel,
              'failed',
              upstream.status,
              Date.now() - startTime,
              errText,
              retryCount,
              downstreamApiKeyId,
              0,
              0,
              0,
              0,
              null,
              clientContext,
              downstreamPath,
            );

            if (isTokenExpiredError({ status: upstream.status, message: errText })) {
              await reportTokenExpired({
                accountId: (selected.account as { id: number }).id,
                username: (selected.account as { username: string }).username,
                siteName: (selected.site as { name: string }).name,
                detail: `HTTP ${upstream.status}`,
              });
            }

            if (
              shouldRetryProxyRequest(upstream.status, errText)
              && await waitForRetryWithinBudget({
                retryCount,
                maxRetries: MAX_RETRIES,
                budget: requestBudget,
                status: upstream.status,
                retryAfterHeader: upstream.headers.get('retry-after'),
              })
            ) {
              return {
                ok: false,
                action: 'failover',
                status: upstream.status,
                rawErrorText: errText,
              };
            }

            return {
              ok: false,
              action: 'stop',
              status: upstream.status,
              rawErrorText: errText,
            };
          }

          if (isStream) {
            reply.raw.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });

            const reader = upstream.body?.getReader();
            if (!reader) {
              reply.raw.end();
              return { ok: true, response: upstream };
            }
            const guardedReader = wrapReaderWithIdleTimeout(reader);

            const decoder = new TextDecoder();
            let parsedUsage: ReturnType<typeof parseProxyUsage> = {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              promptTokensIncludeCache: null,
            };
            let sseBuffer = '';
            try {
              while (true) {
                const { done, value } = await guardedReader.read();
                if (done) break;
                if (!value) continue;
                const chunk = decoder.decode(value as Uint8Array, { stream: true });
                reply.raw.write(chunk);

                sseBuffer += chunk;
                const pulled = pullSseDataEvents(sseBuffer);
                sseBuffer = pulled.rest;
                for (const eventPayload of pulled.events) {
                  try {
                    parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(JSON.parse(eventPayload)));
                  } catch {}
                }
              }
              if (sseBuffer.trim().length > 0) {
                const pulled = pullSseDataEvents(`${sseBuffer}\n\n`);
                for (const eventPayload of pulled.events) {
                  try {
                    parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(JSON.parse(eventPayload)));
                  } catch {}
                }
              }
            } finally {
              guardedReader.releaseLock?.();
              reply.raw.end();
            }

            const latency = Date.now() - startTime;
            const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
              site: selected.site,
              account: selected.account,
              tokenValue: selected.tokenValue,
              tokenName: selected.tokenName,
              modelName: selected.actualModel || requestedModel,
              requestStartedAtMs: startTime,
              requestEndedAtMs: startTime + latency,
              localLatencyMs: latency,
              usage: {
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
              },
            });
            const { estimatedCost, billingDetails } = await resolveProxyLogBilling({
              site: selected.site,
              account: selected.account,
              modelName: selected.actualModel || requestedModel,
              parsedUsage,
              resolvedUsage,
            });
            await tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, selected.actualModel);
            recordDownstreamCostUsage(request, estimatedCost);
            logProxy(
              selected,
              requestedModel,
              'success',
              200,
              latency,
              null,
              retryCount,
              downstreamApiKeyId,
              resolvedUsage.promptTokens,
              resolvedUsage.completionTokens,
              resolvedUsage.totalTokens,
              estimatedCost,
              billingDetails,
              clientContext,
              downstreamPath,
            );
            return {
              ok: true,
              response: upstream,
              latencyMs: latency,
              cost: estimatedCost,
            };
          }

          const rawText = await upstream.text();
          let data: any = rawText;
          try {
            data = JSON.parse(rawText);
          } catch {
            data = rawText;
          }
          const latency = Date.now() - startTime;
          const parsedUsage = parseProxyUsage(data);
          const failure = detectProxyFailure({ rawText, usage: parsedUsage });
          if (failure) {
            const errText = failure.reason;
            await tokenRouter.recordFailure(selected.channel.id, {
              status: failure.status,
              errorText: errText,
              modelName: selected.actualModel,
            });
            logProxy(
              selected,
              requestedModel,
              'failed',
              failure.status,
              latency,
              errText,
              retryCount,
              downstreamApiKeyId,
              0,
              0,
              0,
              0,
              null,
              clientContext,
              downstreamPath,
            );

            if (
              shouldRetryProxyRequest(failure.status, errText)
              && await waitForRetryWithinBudget({
                retryCount,
                maxRetries: MAX_RETRIES,
                budget: requestBudget,
                status: failure.status,
              })
            ) {
              return {
                ok: false,
                action: 'failover',
                status: failure.status,
                rawErrorText: errText,
              };
            }

            return {
              ok: false,
              action: 'stop',
              status: failure.status,
              rawErrorText: errText,
            };
          }

          const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
            site: selected.site,
            account: selected.account,
            tokenValue: selected.tokenValue,
            tokenName: selected.tokenName,
            modelName: selected.actualModel || requestedModel,
            requestStartedAtMs: startTime,
            requestEndedAtMs: startTime + latency,
            localLatencyMs: latency,
            usage: {
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
            },
          });
          const { estimatedCost, billingDetails } = await resolveProxyLogBilling({
            site: selected.site,
            account: selected.account,
            modelName: selected.actualModel || requestedModel,
            parsedUsage,
            resolvedUsage,
          });

          await tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, selected.actualModel);
          recordDownstreamCostUsage(request, estimatedCost);
          logProxy(
            selected,
            requestedModel,
            'success',
            200,
            latency,
            null,
            retryCount,
            downstreamApiKeyId,
            resolvedUsage.promptTokens,
            resolvedUsage.completionTokens,
            resolvedUsage.totalTokens,
            estimatedCost,
            billingDetails,
            clientContext,
            downstreamPath,
            !isStream && responseCacheKey ? { cacheStatus: 'miss', cacheSavedCost: 0 } : null,
          );
          if (responseCacheKey && inflightReservation) {
            const cachedResponse = {
              body: JSON.stringify(data),
              isStream: false,
              promptTokens: resolvedUsage.promptTokens,
              completionTokens: resolvedUsage.completionTokens,
              estimatedCost,
            };
            writeResponseCache(responseCacheKey, requestedModel, cachedResponse)
              .then(() => inflightReservation?.resolve({ response: cachedResponse, cacheStatus: 'hit' }))
              .catch((error) => inflightReservation?.reject(error));
          }
          reply.header('X-Cache', 'MISS').send(data);
          return {
            ok: true,
            response: upstream,
            latencyMs: latency,
            cost: estimatedCost,
          };
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
            0,
            0,
            0,
            null,
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
    const retryCount = Math.max(0, execution.attempts - 1);

    if (!reportedNoChannel) {
      await reportProxyAllFailed({
        model: requestedModel,
        reason: finalStatus === 504 ? requestBudget.buildTimeoutMessage() : finalMessage,
      });
    }

    let staleFallback: Awaited<ReturnType<typeof lookupStaleResponseCache>> = null;
    if (responseCacheKey) {
      staleFallback = await lookupStaleResponseCache(responseCacheKey, config.responseCacheStaleIfErrorMs);
    }
    if (staleFallback) {
      inflightReservation?.resolve({ response: staleFallback, cacheStatus: 'stale' });
      await logProxy({
        channel: { routeId: null, id: null } as any,
        account: { id: null } as any,
        actualModel: requestedModel,
        site: { name: 'cache', url: '', platform: 'cache' } as any,
        tokenName: 'response_cache',
      }, requestedModel, 'success', 200, 0, 'served stale cache after upstream failure', retryCount, downstreamApiKeyId, staleFallback.promptTokens, staleFallback.completionTokens, staleFallback.promptTokens + staleFallback.completionTokens, 0, null, clientContext, downstreamPath, { cacheStatus: 'stale', cacheSavedCost: staleFallback.estimatedCost });
      return reply.header('X-Cache', 'STALE').send(JSON.parse(staleFallback.body));
    }

    const failurePayload = {
      error: {
        message: finalStatus === 502 ? `Upstream error: ${finalMessage}` : finalMessage,
        type: 'upstream_error',
      },
    };
    inflightReservation?.reject({ statusCode: finalStatus, payload: failurePayload });
    return reply.code(finalStatus).send(failurePayload);
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
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  estimatedCost = 0,
  billingDetails: unknown = null,
  clientContext: DownstreamClientContext | null = null,
  downstreamPath = '/v1/completions',
  cacheMeta: { cacheStatus?: string | null; cacheSavedCost?: number | null } | null = null,
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
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCost,
      billingDetails,
      cacheStatus: cacheMeta?.cacheStatus || null,
      cacheSavedCost: cacheMeta?.cacheSavedCost ?? 0,
      clientFamily: clientContext?.clientKind || null,
      clientAppId: clientContext?.clientAppId || null,
      clientAppName: clientContext?.clientAppName || null,
      clientConfidence: clientContext?.clientConfidence || null,
      errorMessage: normalizedErrorMessage,
      retryCount,
      createdAt,
    });
  } catch (error) {
    console.warn('[proxy/completions] failed to write proxy log', error);
  }
}
