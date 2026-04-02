import { TextDecoder } from 'node:util';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutesOnDemand } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldAvoidSiteForRequest, shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { type DownstreamFormat } from '../../transformers/shared/normalized.js';
import {
  buildClaudeCountTokensUpstreamRequest,
  buildUpstreamEndpointRequest,
  recordUpstreamEndpointFailure,
  recordUpstreamEndpointSuccess,
  resolveUpstreamEndpointCandidates,
} from '../../routes/proxy/upstreamEndpoint.js';
import {
  ensureModelAllowedForDownstreamKey,
  getDownstreamRoutingPolicy,
  recordDownstreamCostUsage,
} from '../../routes/proxy/downstreamPolicy.js';
import { composeProxyLogMessage } from '../../routes/proxy/logPathMeta.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../../routes/proxy/endpointFlow.js';
import { detectProxyFailure } from '../../routes/proxy/proxyFailureJudge.js';
import { buildUpstreamUrl } from '../../routes/proxy/upstreamUrl.js';
import { logProxyNoChannelFailure } from '../../routes/proxy/proxyNoChannelLog.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { config } from '../../config.js';
import { resolveProxyLogBilling } from '../../routes/proxy/proxyBilling.js';
import { openAiChatTransformer } from '../../transformers/openai/chat/index.js';
import { anthropicMessagesTransformer } from '../../transformers/anthropic/messages/index.js';
import { getProxyAuthContext, getProxyResourceOwner } from '../../middleware/auth.js';
import {
  ProxyInputFileResolutionError,
  resolveOpenAiBodyInputFiles,
} from '../../services/proxyInputFileResolver.js';
import {
  buildOauthProviderHeaders,
} from '../../services/oauth/service.js';
import { getOauthInfoFromExtraConfig } from '../../services/oauth/oauthAccount.js';
import { recordOauthQuotaResetHint } from '../../services/oauth/quota.js';
import { refreshOauthAccessTokenSingleflight } from '../../services/oauth/refreshSingleflight.js';
import {
  collectResponsesFinalPayloadFromSse,
  collectResponsesFinalPayloadFromSseText,
  createSingleChunkStreamReader,
  looksLikeResponsesSseText,
} from '../../routes/proxy/responsesSseFinal.js';
import {
  createGeminiCliStreamReader,
  unwrapGeminiCliPayload,
} from '../../routes/proxy/geminiCliCompat.js';
import { dispatchRuntimeRequest } from '../../routes/proxy/runtimeExecutor.js';
import { createRequestBudget, shouldRetryWithinBudget, waitForRetryWithinBudget } from '../../routes/proxy/requestBudget.js';
import { wrapReaderWithIdleTimeout } from '../../routes/proxy/streamTimeout.js';
import { summarizeConversationFileInputsInOpenAiBody } from '../capabilities/conversationFileCapabilities.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from '../../routes/proxy/downstreamClientContext.js';
import { recordProxyDebugTrace } from '../../routes/proxy/proxyDebugTrace.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { buildCacheKey, buildRouteScope, lookupResponseCache, lookupStaleResponseCache, recordResponseCacheMiss, writeResponseCache } from '../../services/responseCacheService.js';
import { DefaultProxyConductor } from '../conductor/DefaultProxyConductor.js';

const MAX_RETRIES = config.proxyMaxRetries;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function handleChatSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamFormat: DownstreamFormat,
) {
  const downstreamTransformer = downstreamFormat === 'claude'
    ? anthropicMessagesTransformer
    : openAiChatTransformer;
  const downstreamPath = downstreamFormat === 'claude' ? '/v1/messages' : '/v1/chat/completions';
  const clientContext = detectDownstreamClientContext({
    downstreamPath,
    headers: request.headers as Record<string, unknown>,
    body: request.body,
  });
  const parsedRequestEnvelope = downstreamTransformer.transformRequest(request.body);
  if (parsedRequestEnvelope.error) {
    return reply.code(parsedRequestEnvelope.error.statusCode).send(parsedRequestEnvelope.error.payload);
  }

  const requestEnvelope = parsedRequestEnvelope.value!;
  const {
    requestedModel,
    isStream,
    upstreamBody,
    claudeOriginalBody,
  } = requestEnvelope.parsed;
  if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;

  const downstreamPolicy = getDownstreamRoutingPolicy(request);
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

  const owner = getProxyResourceOwner(request);
  let resolvedOpenAiBody = upstreamBody;
  if (owner) {
    try {
      resolvedOpenAiBody = await resolveOpenAiBodyInputFiles(upstreamBody, owner);
    } catch (error) {
      if (error instanceof ProxyInputFileResolutionError) {
        return reply.code(error.statusCode).send(error.payload);
      }
      throw error;
    }
  }
  const conversationFileSummary = summarizeConversationFileInputsInOpenAiBody(resolvedOpenAiBody);
  const hasNonImageFileInput = conversationFileSummary.hasDocument;
  const codexSessionCacheKey = deriveCodexSessionCacheKey({
    downstreamFormat,
    body: downstreamFormat === 'claude' ? claudeOriginalBody : request.body,
    requestedModel,
    proxyToken: getProxyAuthContext(request)?.token || null,
  });
  const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;

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
        surface: `chat:${downstreamFormat}`,
        model: requestedModel,
        messages: (request.body as Record<string, unknown>)?.messages,
        temperature: (request.body as Record<string, unknown>)?.temperature as number | null | undefined,
        top_p: (request.body as Record<string, unknown>)?.top_p as number | null | undefined,
        max_tokens: (request.body as Record<string, unknown>)?.max_tokens as number | null | undefined,
        stop: (request.body as Record<string, unknown>)?.stop,
        seed: (request.body as Record<string, unknown>)?.seed as number | null | undefined,
        tools: (request.body as Record<string, unknown>)?.tools,
        tool_choice: (request.body as Record<string, unknown>)?.tool_choice,
        response_format: (request.body as Record<string, unknown>)?.response_format,
        reasoning: (request.body as Record<string, unknown>)?.reasoning,
        modalities: (request.body as Record<string, unknown>)?.modalities,
        routeScope,
        requestFingerprint: request.body,
      })
    : null;
  if (responseCacheKey) {
    const cached = await lookupResponseCache(responseCacheKey);
    if (cached) {
      await logProxy(
        {
          channel: { routeId: null, id: null },
          account: { id: null, username: 'cache' },
          actualModel: requestedModel,
        },
        requestedModel,
        'success',
        200,
        0,
        'response cache hit',
        0,
        downstreamPath,
        cached.promptTokens,
        cached.completionTokens,
        cached.promptTokens + cached.completionTokens,
        0,
        null,
        null,
        clientContext,
        downstreamApiKeyId,
        { cacheStatus: 'hit', cacheSavedCost: cached.estimatedCost },
      );
      return reply.header('X-Cache', 'HIT').send(JSON.parse(cached.body));
    }
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

      recordProxyDebugTrace({
        clientContext,
        kind: 'channel_selected',
        requestedModel,
        actualModel: selected.actualModel || requestedModel,
        downstreamPath,
        selected,
        retryCount,
      });

      const modelName = selected.actualModel || requestedModel;
      const oauth = getOauthInfoFromExtraConfig(selected.account.extraConfig);
      const isCodexSite = String(selected.site.platform || '').trim().toLowerCase() === 'codex';
      const endpointCandidates = [
        ...await resolveUpstreamEndpointCandidates(
          {
            site: selected.site,
            account: selected.account,
          },
          modelName,
          downstreamFormat,
          requestedModel,
          {
            hasNonImageFileInput,
            conversationFileSummary,
          },
        ),
      ];
      const endpointRuntimeContext = {
        siteId: selected.site.id,
        accountId: selected.account.id,
        accountAccessToken: selected.account.accessToken ?? null,
        accountApiToken: (selected.account as { apiToken?: string | null }).apiToken ?? null,
        siteApiKey: selected.site.apiKey ?? null,
        modelName,
        downstreamFormat,
        requestedModelHint: requestedModel,
        requestCapabilities: {
          hasNonImageFileInput,
          conversationFileSummary,
        },
      };
      const buildProviderHeaders = () => (
        buildOauthProviderHeaders({
          extraConfig: typeof selected.account.extraConfig === 'string' ? selected.account.extraConfig : null,
          downstreamHeaders: request.headers as Record<string, unknown>,
        })
      );
      const buildEndpointRequest = (
        endpoint: 'chat' | 'messages' | 'responses',
        options: { forceNormalizeClaudeBody?: boolean } = {},
      ) => {
        const upstreamStream = isStream || (isCodexSite && endpoint === 'responses');
        const endpointRequest = buildUpstreamEndpointRequest({
          endpoint,
          modelName,
          stream: upstreamStream,
          tokenValue: selected.tokenValue || '',
          oauthProvider: oauth?.provider,
          oauthProjectId: oauth?.projectId,
          sitePlatform: selected.site.platform,
          siteUrl: selected.site.url,
          openaiBody: resolvedOpenAiBody,
          downstreamFormat,
          claudeOriginalBody,
          forceNormalizeClaudeBody: options.forceNormalizeClaudeBody,
          downstreamHeaders: request.headers as Record<string, unknown>,
          providerHeaders: buildProviderHeaders(),
          codexSessionCacheKey,
        });
        return {
          endpoint,
          path: endpointRequest.path,
          headers: endpointRequest.headers,
          body: endpointRequest.body as Record<string, unknown>,
          runtime: endpointRequest.runtime,
        };
      };
      const channelProxyUrl = resolveChannelProxyUrl(selected.site, selected.account.extraConfig);
      const dispatchRequest = (
        compatibilityRequest: BuiltEndpointRequest,
        targetUrl?: string,
      ) => (
        dispatchRuntimeRequest({
          siteUrl: selected.site.url,
          targetUrl,
          request: {
            ...compatibilityRequest,
            runtime: compatibilityRequest.runtime
              ? {
                ...compatibilityRequest.runtime,
                timeoutMs: requestBudget.getPerAttemptTimeoutMs({ preferFastFail: true }),
              }
              : undefined,
          },
          buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: requestForFetch.headers,
            body: JSON.stringify(requestForFetch.body),
          }, channelProxyUrl),
        })
      );
      const endpointStrategy = downstreamTransformer.compatibility.createEndpointStrategy({
        downstreamFormat,
        endpointCandidates,
        modelName,
        requestedModelHint: requestedModel,
        sitePlatform: selected.site.platform,
        isStream: isStream || isCodexSite,
        buildRequest: ({ endpoint, forceNormalizeClaudeBody }) => buildEndpointRequest(
          endpoint,
          { forceNormalizeClaudeBody },
        ),
        dispatchRequest,
      });
      const tryRecover = async (ctx: Parameters<NonNullable<typeof endpointStrategy.tryRecover>>[0]) => {
        if ((ctx.response.status === 401 || ctx.response.status === 403) && oauth) {
          try {
            const refreshed = await refreshOauthAccessTokenSingleflight(selected.account.id);
            selected.tokenValue = refreshed.accessToken;
            selected.account = {
              ...selected.account,
              accessToken: refreshed.accessToken,
              extraConfig: refreshed.extraConfig ?? selected.account.extraConfig,
            };
            const refreshedRequest = buildEndpointRequest(ctx.request.endpoint);
            const refreshedTargetUrl = buildUpstreamUrl(selected.site.url, refreshedRequest.path);
            const refreshedResponse = await dispatchRequest(refreshedRequest, refreshedTargetUrl);
            if (refreshedResponse.ok) {
              return {
                upstream: refreshedResponse,
                upstreamPath: refreshedRequest.path,
              };
            }
            ctx.request = refreshedRequest;
            ctx.response = refreshedResponse;
            ctx.rawErrText = await refreshedResponse.text().catch(() => 'unknown error');
          } catch {
            return endpointStrategy.tryRecover(ctx);
          }
        }
        return endpointStrategy.tryRecover(ctx);
      };
      const startTime = Date.now();

      try {
        const endpointResult = await executeEndpointFlow({
          siteUrl: selected.site.url,
          endpointCandidates,
          buildRequest: (endpoint) => buildEndpointRequest(endpoint),
          dispatchRequest,
          tryRecover,
          onAttemptFailure: (ctx) => {
            recordUpstreamEndpointFailure({
              ...endpointRuntimeContext,
              endpoint: ctx.request.endpoint,
              status: ctx.response.status,
              errorText: ctx.rawErrText,
            });
          },
          onAttemptSuccess: (ctx) => {
            recordUpstreamEndpointSuccess({
              ...endpointRuntimeContext,
              endpoint: ctx.request.endpoint,
            });
          },
          shouldDowngrade: endpointStrategy.shouldDowngrade,
          onDowngrade: (ctx) => {
            recordProxyDebugTrace({
              clientContext,
              kind: 'endpoint_downgrade',
              requestedModel,
              actualModel: modelName,
              downstreamPath,
              selected,
              endpoint: ctx.request.endpoint,
              endpointPath: ctx.request.path,
              status: ctx.response.status,
              retryCount,
              reason: ctx.errText,
            });
            logProxy(
              selected,
              requestedModel,
              'failed',
              ctx.response.status,
              Date.now() - startTime,
              ctx.errText,
              retryCount,
              downstreamPath,
              0,
              0,
              0,
              0,
              null,
              null,
              clientContext,
              downstreamApiKeyId,
            );
          },
        });

        if (!endpointResult.ok) {
          const status = endpointResult.status || 502;
          const errText = endpointResult.errText || 'unknown error';
          const rawErrText = endpointResult.rawErrText || errText;
          const retryAfterHeader = endpointResult.retryAfterHeader ?? null;
          recordProxyDebugTrace({
            clientContext,
            kind: 'endpoint_final_failure',
            requestedModel,
            actualModel: modelName,
            downstreamPath,
            selected,
            status,
            retryCount,
            reason: errText,
          });
          await tokenRouter.recordFailure(selected.channel.id, {
            status,
            errorText: rawErrText,
            modelName,
            retryAfterHeader,
          });
          logProxy(
            selected,
            requestedModel,
            'failed',
            status,
            Date.now() - startTime,
            errText,
            retryCount,
            downstreamPath,
            0,
            0,
            0,
            0,
            null,
            null,
            clientContext,
            downstreamApiKeyId,
          );
          await recordOauthQuotaResetHint({
            accountId: selected.account.id,
            statusCode: status,
            errorText: rawErrText,
          });

          if (isTokenExpiredError({ status, message: errText })) {
            await reportTokenExpired({
              accountId: selected.account.id,
              username: selected.account.username,
              siteName: selected.site.name,
              detail: `HTTP ${status}`,
            });
          }

          if (
            shouldRetryProxyRequest(status, errText)
            && await waitForRetryWithinBudget({
              retryCount,
              maxRetries: MAX_RETRIES,
              budget: requestBudget,
              status,
              retryAfterHeader,
            })
          ) {
            return {
              ok: false,
              action: 'failover',
              status,
              rawErrorText: errText,
              retryAfterHeader,
            };
          }

          return {
            ok: false,
            action: 'stop',
            status,
            rawErrorText: errText,
            retryAfterHeader,
          };
        }

        const upstream = endpointResult.upstream as any;
        const successfulUpstreamPath = endpointResult.upstreamPath;

        if (isStream) {
          const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
          const startSseResponse = () => {
            reply.hijack();
            reply.raw.statusCode = 200;
            reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no');
          };

          let parsedUsage: ReturnType<typeof parseProxyUsage> = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            promptTokensIncludeCache: null,
          };
          const writeLines = (lines: string[]) => {
            for (const line of lines) {
              reply.raw.write(line);
            }
          };
          const streamSession = openAiChatTransformer.proxyStream.createSession({
            downstreamFormat,
            modelName,
            successfulUpstreamPath,
            onParsedPayload: (payload) => {
              if (payload && typeof payload === 'object') {
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(payload));
              }
            },
            writeLines,
            writeRaw: (chunk) => {
              reply.raw.write(chunk);
            },
          });
          let rawText = '';
          if (!upstreamContentType.includes('text/event-stream')) {
            const fallbackText = await upstream.text();
            rawText = fallbackText;
            if (looksLikeResponsesSseText(fallbackText)) {
              startSseResponse();
              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(fallbackText),
                reply.raw,
              );
              if (streamResult.status === 'failed') {
                const latency = Date.now() - startTime;
                await tokenRouter.recordFailure(selected.channel.id, {
                  status: 502,
                  errorText: streamResult.errorMessage,
                  modelName,
                });
                logProxy(
                  selected,
                  requestedModel,
                  'failed',
                  200,
                  latency,
                  streamResult.errorMessage,
                  retryCount,
                  downstreamPath,
                  parsedUsage.promptTokens,
                  parsedUsage.completionTokens,
                  parsedUsage.totalTokens,
                  0,
                  null,
                  successfulUpstreamPath,
                  clientContext,
                  downstreamApiKeyId,
                );
                return { ok: true, response: upstream };
              }
            } else {
              let fallbackData: unknown = null;
              try {
                fallbackData = JSON.parse(fallbackText);
              } catch {
                fallbackData = fallbackText;
              }
              if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
                fallbackData = unwrapGeminiCliPayload(fallbackData);
              }
              parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(fallbackData));
              const failure = detectProxyFailure({ rawText, usage: parsedUsage });
              if (failure) {
                const latency = Date.now() - startTime;
                await tokenRouter.recordFailure(selected.channel.id, {
                  status: failure.status,
                  errorText: failure.reason,
                  modelName,
                });
                logProxy(
                  selected,
                  requestedModel,
                  'failed',
                  failure.status,
                  latency,
                  failure.reason,
                  retryCount,
                  downstreamPath,
                  parsedUsage.promptTokens,
                  parsedUsage.completionTokens,
                  parsedUsage.totalTokens,
                  0,
                  null,
                  successfulUpstreamPath,
                  clientContext,
                  downstreamApiKeyId,
                );

                const failureMessage = `[upstream:${successfulUpstreamPath}] ${failure.reason}`;
              if (
                shouldRetryProxyRequest(failure.status, failure.reason)
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
                  rawErrorText: failureMessage,
                };
              }

              return {
                ok: false,
                action: 'stop',
                status: failure.status,
                rawErrorText: failureMessage,
              };
              }

              startSseResponse();
              const streamResult = streamSession.consumeUpstreamFinalPayload(fallbackData, fallbackText, reply.raw);
              if (streamResult.status === 'failed') {
                const latency = Date.now() - startTime;
                await tokenRouter.recordFailure(selected.channel.id, {
                  status: 502,
                  errorText: streamResult.errorMessage,
                  modelName,
                });
                logProxy(
                  selected,
                  requestedModel,
                  'failed',
                  200,
                  latency,
                  streamResult.errorMessage,
                  retryCount,
                  downstreamPath,
                  parsedUsage.promptTokens,
                  parsedUsage.completionTokens,
                  parsedUsage.totalTokens,
                  0,
                  null,
                  successfulUpstreamPath,
                  clientContext,
                  downstreamApiKeyId,
                );
                return { ok: true, response: upstream };
              }
            }
          } else {
            startSseResponse();
            const upstreamReader = upstream.body?.getReader();
            const baseReader = String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli' && upstreamReader
              ? createGeminiCliStreamReader(upstreamReader)
              : upstreamReader;
            const decoder = new TextDecoder();
            const reader = baseReader
              ? {
                async read() {
                  const result = await baseReader.read();
                  if (result.value) {
                    rawText += decoder.decode(result.value, { stream: true });
                  }
                  return result;
                },
                async cancel(reason?: unknown) {
                  return baseReader.cancel(reason);
                },
                releaseLock() {
                  return baseReader.releaseLock();
                },
              }
              : baseReader;
            const streamResult = await streamSession.run(reader ? wrapReaderWithIdleTimeout(reader) : reader, reply.raw);
            rawText += decoder.decode();
            if (streamResult.status === 'failed') {
              const latency = Date.now() - startTime;
              await tokenRouter.recordFailure(selected.channel.id, {
                status: 502,
                errorText: streamResult.errorMessage,
                modelName,
              });
              logProxy(
                selected,
                requestedModel,
                'failed',
                200,
                latency,
                streamResult.errorMessage,
                retryCount,
                downstreamPath,
                parsedUsage.promptTokens,
                parsedUsage.completionTokens,
                parsedUsage.totalTokens,
                0,
                null,
                successfulUpstreamPath,
                clientContext,
                downstreamApiKeyId,
              );
              return { ok: true, response: upstream };
            }
          }

          const latency = Date.now() - startTime;
          const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
            site: selected.site,
            account: selected.account,
            tokenValue: selected.tokenValue || '',
            tokenName: selected.tokenName,
            modelName,
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
            modelName,
            parsedUsage,
            resolvedUsage,
          });

          await tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, modelName);
          recordDownstreamCostUsage(request, estimatedCost);
          logProxy(
            selected,
            requestedModel,
            'success',
            200,
            latency,
            null,
            retryCount,
            downstreamPath,
            resolvedUsage.promptTokens,
            resolvedUsage.completionTokens,
            resolvedUsage.totalTokens,
            estimatedCost,
            billingDetails,
            successfulUpstreamPath,
            clientContext,
            downstreamApiKeyId,
          );
          return {
            ok: true,
            response: upstream,
            latencyMs: latency,
            cost: estimatedCost,
          };
        }

        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        let rawText = '';
        let upstreamData: unknown;
        if (upstreamContentType.includes('text/event-stream') && successfulUpstreamPath.endsWith('/responses')) {
          const collected = await collectResponsesFinalPayloadFromSse(upstream, modelName);
          rawText = collected.rawText;
          upstreamData = collected.payload;
        } else {
          rawText = await upstream.text();
          if (looksLikeResponsesSseText(rawText)) {
            upstreamData = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
          } else {
            upstreamData = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
          }
        }
        if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
          upstreamData = unwrapGeminiCliPayload(upstreamData);
        }

        const latency = Date.now() - startTime;
        const parsedUsage = parseProxyUsage(upstreamData);
        const failure = detectProxyFailure({ rawText, usage: parsedUsage });
        if (failure) {
          await tokenRouter.recordFailure(selected.channel.id, {
            status: failure.status,
            errorText: failure.reason,
            modelName,
          });
          logProxy(
            selected,
            requestedModel,
            'failed',
            failure.status,
            latency,
            failure.reason,
            retryCount,
            downstreamPath,
            parsedUsage.promptTokens,
            parsedUsage.completionTokens,
            parsedUsage.totalTokens,
            0,
            null,
            successfulUpstreamPath,
            clientContext,
            downstreamApiKeyId,
          );

          const failureMessage = `[upstream:${successfulUpstreamPath}] ${failure.reason}`;
          if (
            shouldRetryProxyRequest(failure.status, failure.reason)
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
              rawErrorText: failureMessage,
            };
          }

          return {
            ok: false,
            action: 'stop',
            status: failure.status,
            rawErrorText: failureMessage,
          };
        }

        const normalizedFinal = downstreamTransformer.transformFinalResponse(upstreamData, modelName, rawText);
        const downstreamResponse = downstreamTransformer.serializeFinalResponse(normalizedFinal, parsedUsage);
        const downstreamFailure = detectProxyFailure({
          rawText: JSON.stringify(downstreamResponse),
          usage: parsedUsage,
        });
        if (downstreamFailure) {
          await tokenRouter.recordFailure(selected.channel.id, {
            status: downstreamFailure.status,
            errorText: downstreamFailure.reason,
            modelName,
          });
          logProxy(
            selected,
            requestedModel,
            'failed',
            downstreamFailure.status,
            latency,
            downstreamFailure.reason,
            retryCount,
            downstreamPath,
            parsedUsage.promptTokens,
            parsedUsage.completionTokens,
            parsedUsage.totalTokens,
            0,
            null,
            successfulUpstreamPath,
            clientContext,
            downstreamApiKeyId,
          );

          const failureMessage = `[upstream:${successfulUpstreamPath}] ${downstreamFailure.reason}`;
          if (
            shouldRetryProxyRequest(downstreamFailure.status, downstreamFailure.reason)
            && await waitForRetryWithinBudget({
              retryCount,
              maxRetries: MAX_RETRIES,
              budget: requestBudget,
              status: downstreamFailure.status,
            })
          ) {
            return {
              ok: false,
              action: 'failover',
              status: downstreamFailure.status,
              rawErrorText: failureMessage,
            };
          }

          return {
            ok: false,
            action: 'stop',
            status: downstreamFailure.status,
            rawErrorText: failureMessage,
          };
        }
        const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
          site: selected.site,
          account: selected.account,
          tokenValue: selected.tokenValue || '',
          tokenName: selected.tokenName,
          modelName,
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
          modelName,
          parsedUsage,
          resolvedUsage,
        });

        await tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, modelName);
        recordProxyDebugTrace({
          clientContext,
          kind: 'proxy_success',
          requestedModel,
          actualModel: modelName,
          downstreamPath,
          selected,
          endpointPath: successfulUpstreamPath,
          status: 200,
          retryCount,
        });
        recordDownstreamCostUsage(request, estimatedCost);
        logProxy(
          selected,
          requestedModel,
          'success',
          200,
          latency,
          null,
          retryCount,
          downstreamPath,
          resolvedUsage.promptTokens,
          resolvedUsage.completionTokens,
          resolvedUsage.totalTokens,
          estimatedCost,
          billingDetails,
          successfulUpstreamPath,
          clientContext,
          downstreamApiKeyId,
          !isStream && responseCacheKey ? { cacheStatus: 'miss', cacheSavedCost: 0 } : null,
        );

        if (responseCacheKey && !isStream) {
          writeResponseCache(responseCacheKey, requestedModel, {
            body: JSON.stringify(downstreamResponse),
            isStream: false,
            promptTokens: resolvedUsage.promptTokens,
            completionTokens: resolvedUsage.completionTokens,
            estimatedCost,
          }).catch(() => {});
        }

        reply.header('X-Cache', 'MISS').send(downstreamResponse);
        return {
          ok: true,
          response: upstream,
          latencyMs: latency,
          cost: estimatedCost,
        };
      } catch (err: any) {
        const errorMessage = err?.message || 'network failure';
        await tokenRouter.recordFailure(selected.channel.id, {
          errorText: errorMessage,
          modelName,
        });
        recordProxyDebugTrace({
          clientContext,
          kind: 'proxy_exception',
          requestedModel,
          actualModel: modelName,
          downstreamPath,
          selected,
          retryCount,
          reason: errorMessage,
        });
        logProxy(
          selected,
          requestedModel,
          'failed',
          0,
          Date.now() - startTime,
          errorMessage,
          retryCount,
          downstreamPath,
          0,
          0,
          0,
          0,
          null,
          null,
          clientContext,
          downstreamApiKeyId,
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

  if (responseCacheKey) {
    const stale = await lookupStaleResponseCache(responseCacheKey, config.responseCacheStaleIfErrorMs);
    if (stale) {
      await logProxy(
        {
          channel: { routeId: null, id: null },
          account: { id: null, username: 'cache' },
          actualModel: requestedModel,
        },
        requestedModel,
        'success',
        200,
        0,
        finalStatus === 504 ? requestBudget.buildTimeoutMessage() : 'served stale cache after upstream failure',
        retryCount,
        downstreamPath,
        stale.promptTokens,
        stale.completionTokens,
        stale.promptTokens + stale.completionTokens,
        0,
        null,
        null,
        clientContext,
        downstreamApiKeyId,
        { cacheStatus: 'stale', cacheSavedCost: stale.estimatedCost },
      );
      return reply.header('X-Cache', 'STALE').send(JSON.parse(stale.body));
    }
  }

  const errorType = execution.reason === 'no_channel' ? 'server_error' : 'upstream_error';
  return reply.code(finalStatus).send({
    error: {
      message: finalStatus === 502 ? `Upstream error: ${finalMessage}` : finalMessage,
      type: errorType,
    },
  });
}

function deriveCodexSessionCacheKey(input: {
  downstreamFormat: DownstreamFormat | 'responses';
  body: unknown;
  requestedModel: string;
  proxyToken: string | null;
}): string | null {
  if (isRecord(input.body)) {
    if (input.downstreamFormat === 'claude' && isRecord(input.body.metadata)) {
      const userId = asTrimmedString(input.body.metadata.user_id);
      if (userId) return `${input.requestedModel}:claude:${userId}`;
    }
    const promptCacheKey = asTrimmedString(input.body.prompt_cache_key);
    if (promptCacheKey) return `${input.requestedModel}:responses:${promptCacheKey}`;
  }

  const proxyToken = asTrimmedString(input.proxyToken);
  if (proxyToken) {
    return `${input.requestedModel}:proxy:${proxyToken}`;
  }

  return null;
}

export async function handleClaudeCountTokensSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const rawBody = isRecord(request.body) ? { ...request.body } : null;
  if (!rawBody) {
    return reply.code(400).send({
      error: {
        message: 'Request body must be a JSON object',
        type: 'invalid_request_error',
      },
    });
  }

  const requestedModel = asTrimmedString(rawBody.model);
  if (!requestedModel) {
    return reply.code(400).send({
      error: {
        message: 'model is required',
        type: 'invalid_request_error',
      },
    });
  }

  if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
  const downstreamPath = '/v1/messages/count_tokens';
  const clientContext = detectDownstreamClientContext({
    downstreamPath,
    headers: request.headers as Record<string, unknown>,
    body: rawBody,
  });
  const downstreamPolicy = getDownstreamRoutingPolicy(request);
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
  const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
  const previewSelected = typeof (tokenRouter as { previewSelectedChannel?: unknown }).previewSelectedChannel === 'function'
    ? await conductor.previewSelectedChannel(requestedModel, downstreamPolicy)
    : null;
  const routeScope = buildRouteScope({
    routeId: previewSelected?.channel.routeId,
    siteId: previewSelected?.site.id,
    actualModel: previewSelected?.actualModel || requestedModel,
  });
  const responseCacheKey = buildCacheKey({
    surface: 'chat:count_tokens',
    model: requestedModel,
    messages: rawBody.messages,
    temperature: 0,
    max_tokens: null,
    routeScope,
    requestFingerprint: rawBody,
  });
  if (responseCacheKey) {
    const cached = await lookupResponseCache(responseCacheKey);
    if (cached) {
      await logProxy(
        {
          channel: { routeId: null, id: null },
          account: { id: null, username: 'cache' },
          actualModel: requestedModel,
        },
        requestedModel,
        'success',
        200,
        0,
        null,
        0,
        downstreamPath,
        cached.promptTokens,
        cached.completionTokens,
        cached.promptTokens + cached.completionTokens,
        0,
        null,
        null,
        clientContext,
        downstreamApiKeyId,
        { cacheStatus: 'hit', cacheSavedCost: cached.estimatedCost },
      );
      return reply.header('X-Cache', 'HIT').send(JSON.parse(cached.body));
    }
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
      const modelName = selected.actualModel || requestedModel;
      const endpointCandidates = await resolveUpstreamEndpointCandidates(
        {
          site: selected.site,
          account: selected.account,
        },
        modelName,
        'claude',
        requestedModel,
      );
      if (!endpointCandidates.includes('messages')) {
        return {
          ok: false,
          action: 'stop',
          status: 501,
          rawErrorText: 'Claude count_tokens compatibility is not implemented for this upstream',
        };
      }

      const oauth = getOauthInfoFromExtraConfig(selected.account.extraConfig);
      const tokenValue = selected.tokenValue || '';
      const startTime = Date.now();
      const buildRequest = () => {
        const upstreamRequest = buildClaudeCountTokensUpstreamRequest({
          modelName,
          tokenValue: selected.tokenValue || '',
          oauthProvider: oauth?.provider,
          sitePlatform: selected.site.platform,
          claudeBody: rawBody,
          downstreamHeaders: request.headers as Record<string, unknown>,
        });
        return {
          endpoint: 'messages' as const,
          path: upstreamRequest.path,
          headers: upstreamRequest.headers,
          body: upstreamRequest.body,
          runtime: upstreamRequest.runtime,
        };
      };

      try {
        let upstreamRequest = buildRequest();
        let upstream = await dispatchRuntimeRequest({
          siteUrl: selected.site.url,
          request: upstreamRequest,
          buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: requestForFetch.headers,
            body: JSON.stringify(requestForFetch.body),
          }, resolveChannelProxyUrl(selected.site, selected.account.extraConfig)),
        });

        if ((upstream.status === 401 || upstream.status === 403) && oauth) {
          try {
            const refreshed = await refreshOauthAccessTokenSingleflight(selected.account.id);
            selected.tokenValue = refreshed.accessToken;
            selected.account = {
              ...selected.account,
              accessToken: refreshed.accessToken,
              extraConfig: refreshed.extraConfig ?? selected.account.extraConfig,
            };
            upstreamRequest = buildRequest();
            upstream = await dispatchRuntimeRequest({
              siteUrl: selected.site.url,
              request: upstreamRequest,
              buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(selected.site, {
                method: 'POST',
                headers: requestForFetch.headers,
                body: JSON.stringify(requestForFetch.body),
              }, resolveChannelProxyUrl(selected.site, selected.account.extraConfig)),
            });
          } catch {
            // Fall through to the regular upstream error handling below.
          }
        }

        const latency = Date.now() - startTime;
        const contentType = upstream.headers.get('content-type') || 'application/json';
        const text = await upstream.text();
        let payload: unknown = text;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }

        if (!upstream.ok) {
          const errorText = typeof payload === 'string' ? payload : text;
          await tokenRouter.recordFailure(selected.channel.id, {
            status: upstream.status,
            errorText,
            modelName,
          });
          logProxy(
            selected,
            requestedModel,
            'failed',
            upstream.status,
            latency,
            typeof payload === 'string' ? payload : JSON.stringify(payload),
            retryCount,
            downstreamPath,
            0,
            0,
            0,
            0,
            null,
            upstreamRequest.path,
            clientContext,
            downstreamApiKeyId,
          );
          if (isTokenExpiredError({ status: upstream.status, message: errorText })) {
            await reportTokenExpired({
              accountId: selected.account.id,
              username: selected.account.username,
              siteName: selected.site.name,
              detail: `HTTP ${upstream.status}`,
            });
          }
          if (
            shouldRetryProxyRequest(upstream.status, errorText)
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
              rawErrorText: errorText,
            };
          }
          return {
            ok: false,
            action: 'stop',
            status: upstream.status,
            rawErrorText: errorText,
            error: { payload, contentType },
          };
        }

        await tokenRouter.recordSuccess(selected.channel.id, latency, 0, modelName);
        recordDownstreamCostUsage(request, 0);
        logProxy(
          selected,
          requestedModel,
          'success',
          upstream.status,
          latency,
          null,
          retryCount,
          downstreamPath,
          0,
          0,
          0,
          0,
          null,
          upstreamRequest.path,
          clientContext,
          downstreamApiKeyId,
          { cacheStatus: 'miss', cacheSavedCost: 0 },
        );
        if (responseCacheKey) {
          writeResponseCache(responseCacheKey, requestedModel, {
            body: JSON.stringify(payload),
            isStream: false,
            promptTokens: 0,
            completionTokens: 0,
            estimatedCost: 0,
          }).catch(() => {});
        }
        reply.header('X-Cache', 'MISS').code(upstream.status).type(contentType).send(payload);
        return {
          ok: true,
          response: upstream,
          latencyMs: latency,
          cost: 0,
        };
      } catch (error: any) {
        const errorMessage = error?.message || 'network failure';
        await tokenRouter.recordFailure(selected.channel.id, {
          errorText: errorMessage,
          modelName,
        });
        logProxy(
          selected,
          requestedModel,
          'failed',
          0,
          Date.now() - startTime,
          errorMessage,
          retryCount,
          downstreamPath,
          0,
          0,
          0,
          0,
          null,
          null,
          clientContext,
          downstreamApiKeyId,
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
      reason: finalMessage,
    });
  }

  if (responseCacheKey) {
    const stale = await lookupStaleResponseCache(responseCacheKey, config.responseCacheStaleIfErrorMs);
    if (stale) {
      await logProxy(
        {
          channel: { routeId: null, id: null },
          account: { id: null, username: 'cache' },
          actualModel: requestedModel,
        },
        requestedModel,
        'success',
        200,
        0,
        'count_tokens stale cache fallback',
        retryCount,
        downstreamPath,
        0,
        0,
        0,
        0,
        null,
        null,
        clientContext,
        downstreamApiKeyId,
        { cacheStatus: 'stale', cacheSavedCost: stale.estimatedCost },
      );
      return reply.header('X-Cache', 'STALE').type('application/json').send(JSON.parse(stale.body));
    }
  }

  if (finalStatus === 501) {
    return reply.code(501).send({
      error: {
        message: 'Claude count_tokens compatibility is not implemented for this upstream',
        type: 'invalid_request_error',
      },
    });
  }

  const errorType = execution.reason === 'no_channel' ? 'server_error' : 'upstream_error';
  return reply.code(finalStatus).send({
    error: {
      message: finalStatus === 502 ? `Upstream error: ${finalMessage}` : finalMessage,
      type: errorType,
    },
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
  downstreamPath: string,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  estimatedCost = 0,
  billingDetails: unknown = null,
  upstreamPath: string | null = null,
  clientContext: DownstreamClientContext | null = null,
  downstreamApiKeyId: number | null = null,
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
      upstreamPath,
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
    console.warn('[proxy/chat] failed to write proxy log', error);
  }
}
