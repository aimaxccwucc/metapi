import { TextDecoder } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutesOnDemand } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldAvoidSiteForRequest, shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import {
  buildUpstreamEndpointRequest,
  recordUpstreamEndpointFailure,
  recordUpstreamEndpointSuccess,
  resolveUpstreamEndpointCandidates,
} from '../../routes/proxy/upstreamEndpoint.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from '../../routes/proxy/downstreamPolicy.js';
import { composeProxyLogMessage } from '../../routes/proxy/logPathMeta.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../../routes/proxy/endpointFlow.js';
import { detectProxyFailure } from '../../routes/proxy/proxyFailureJudge.js';
import { buildUpstreamUrl } from '../../routes/proxy/upstreamUrl.js';
import { logProxyNoChannelFailure } from '../../routes/proxy/proxyNoChannelLog.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { resolveProxyLogBilling } from '../../routes/proxy/proxyBilling.js';
import { getProxyAuthContext, getProxyResourceOwner } from '../../middleware/auth.js';
import { dispatchRuntimeRequest } from '../../routes/proxy/runtimeExecutor.js';
import { createRequestBudget, shouldRetryWithinBudget, waitForRetryWithinBudget } from '../../routes/proxy/requestBudget.js';
import { wrapReaderWithIdleTimeout } from '../../routes/proxy/streamTimeout.js';
import { normalizeInputFileBlock } from '../../transformers/shared/inputFile.js';
import {
  ProxyInputFileResolutionError,
  resolveResponsesBodyInputFiles,
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
import { isCodexResponsesSurface } from '../cliProfiles/codexProfile.js';
import {
  summarizeConversationFileInputsInOpenAiBody,
  summarizeConversationFileInputsInResponsesBody,
} from '../capabilities/conversationFileCapabilities.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from '../../routes/proxy/downstreamClientContext.js';
import { recordProxyDebugTrace } from '../../routes/proxy/proxyDebugTrace.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { buildCacheKey, buildRouteScope, lookupResponseCache, lookupStaleResponseCache, recordResponseCacheMiss, writeResponseCache } from '../../services/responseCacheService.js';
import { DefaultProxyConductor } from '../conductor/DefaultProxyConductor.js';

const MAX_RETRIES = config.proxyMaxRetries;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function normalizeIncludeList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function hasExplicitInclude(body: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'include');
}

function hasResponsesReasoningRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const relevantKeys = ['effort', 'budget_tokens', 'budgetTokens', 'max_tokens', 'maxTokens', 'summary'];
  return relevantKeys.some((key) => {
    const entry = value[key];
    if (typeof entry === 'string') return entry.trim().length > 0;
    return entry !== undefined && entry !== null;
  });
}

function carriesResponsesReasoningContinuity(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => carriesResponsesReasoningContinuity(item));
  }
  if (!isRecord(value)) return false;

  const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  if (type === 'reasoning') {
    if (typeof value.encrypted_content === 'string' && value.encrypted_content.trim()) {
      return true;
    }
    if (Array.isArray(value.summary) && value.summary.length > 0) {
      return true;
    }
  }

  if (typeof value.reasoning_signature === 'string' && value.reasoning_signature.trim()) {
    return true;
  }

  return carriesResponsesReasoningContinuity(value.input)
    || carriesResponsesReasoningContinuity(value.content);
}

function wantsNativeResponsesReasoning(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const include = normalizeIncludeList(body.include);
  if (include.some((item) => item.toLowerCase() === 'reasoning.encrypted_content')) {
    return true;
  }
  if (carriesResponsesReasoningContinuity(body.input)) {
    return true;
  }
  if (hasExplicitInclude(body)) {
    return false;
  }
  return hasResponsesReasoningRequest(body.reasoning);
}

function carriesResponsesFileUrlInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => carriesResponsesFileUrlInput(item));
  }
  if (!isRecord(value)) return false;

  const normalizedFile = normalizeInputFileBlock(value);
  if (normalizedFile?.fileUrl) return true;

  return Object.values(value).some((entry) => carriesResponsesFileUrlInput(entry));
}

function shouldRefreshOauthResponsesRequest(input: {
  oauthProvider?: string;
  status: number;
  response: { headers: { get(name: string): string | null } };
  rawErrText: string;
}): boolean {
  if (input.status === 401) return true;
  if (input.status !== 403 || input.oauthProvider !== 'codex') return false;
  const authenticate = input.response.headers.get('www-authenticate') || '';
  const combined = `${authenticate}\n${input.rawErrText || ''}`;
  return /\b(invalid_token|expired_token|expired|invalid|unauthorized|account mismatch|authentication)\b/i.test(combined);
}

type UsageSummary = ReturnType<typeof parseProxyUsage>;

export async function handleOpenAiResponsesSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamPath: '/v1/responses' | '/v1/responses/compact',
) {
  const body = request.body as Record<string, unknown>;
  const clientContext = detectDownstreamClientContext({
    downstreamPath,
    headers: request.headers as Record<string, unknown>,
    body,
  });
  const defaultEncryptedReasoningInclude = isCodexResponsesSurface(
    request.headers as Record<string, unknown>,
  );
  const parsedRequestEnvelope = openAiResponsesTransformer.transformRequest(body, {
    defaultEncryptedReasoningInclude,
  });
  if (parsedRequestEnvelope.error) {
    return reply.code(parsedRequestEnvelope.error.statusCode).send(parsedRequestEnvelope.error.payload);
  }
  const requestEnvelope = parsedRequestEnvelope.value!;
  const requestedModel = requestEnvelope.model;
  const isStream = requestEnvelope.stream;
  const isCompactRequest = downstreamPath === '/v1/responses/compact';
  if (isCompactRequest && isStream) {
    return reply.code(400).send({
      error: {
        message: 'stream is not supported on /v1/responses/compact',
        type: 'invalid_request_error',
      },
    });
  }
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
        surface: isCompactRequest ? 'responses:compact' : 'responses:default',
        model: requestedModel,
        messages: requestEnvelope.parsed.normalizedBody.input,
        input: requestEnvelope.parsed.normalizedBody.input,
        temperature: (body.temperature as number | null | undefined),
        top_p: (body.top_p as number | null | undefined),
        max_tokens: ((body.max_output_tokens ?? body.max_tokens) as number | null | undefined),
        stop: body.stop,
        seed: body.seed as number | null | undefined,
        tools: body.tools,
        tool_choice: body.tool_choice,
        response_format: body.text,
        reasoning: body.reasoning,
        modalities: body.modalities,
        routeScope,
        requestFingerprint: requestEnvelope.parsed.normalizedBody,
      })
    : null;
  const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;

  if (responseCacheKey) {
    const cached = await lookupResponseCache(responseCacheKey);
    if (cached) {
      await logProxy(
        {
          channel: { routeId: null, id: null },
          account: { id: null, username: 'cache' },
          actualModel: requestedModel,
          site: { name: '本地缓存', url: '', platform: 'cache' },
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
      const owner = getProxyResourceOwner(request);
      let normalizedResponsesBody: Record<string, unknown> = {
        ...requestEnvelope.parsed.normalizedBody,
        model: modelName,
        stream: isStream,
      };
      if (body.generate === false) {
        normalizedResponsesBody.generate = false;
      }
      if (owner) {
        try {
          normalizedResponsesBody = await resolveResponsesBodyInputFiles(normalizedResponsesBody, owner);
        } catch (error) {
          if (error instanceof ProxyInputFileResolutionError) {
            reply.code(error.statusCode).send(error.payload);
            return { ok: true, response: null };
          }
          throw error;
        }
      }

      const openAiBody = openAiResponsesTransformer.inbound.toOpenAiBody(
        normalizedResponsesBody,
        modelName,
        isStream,
        { defaultEncryptedReasoningInclude },
      );
      const conversationFileSummary = summarizeConversationFileInputsInOpenAiBody(openAiBody);
      const hasNonImageFileInput = conversationFileSummary.hasDocument;
      const prefersNativeResponsesReasoning = wantsNativeResponsesReasoning(normalizedResponsesBody);
      const responsesConversationFileSummary = summarizeConversationFileInputsInResponsesBody(normalizedResponsesBody);
      const requiresNativeResponsesFileUrl = responsesConversationFileSummary.hasRemoteDocumentUrl
        || carriesResponsesFileUrlInput(normalizedResponsesBody.input);
      const endpointCandidates = await resolveUpstreamEndpointCandidates(
        {
          site: selected.site,
          account: selected.account,
        },
        modelName,
        'responses',
        requestedModel,
        {
          hasNonImageFileInput,
          conversationFileSummary,
          wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
        },
      );
      if (endpointCandidates.length === 0) {
        endpointCandidates.push('responses', 'chat', 'messages');
      }

      const endpointRuntimeContext = {
        siteId: selected.site.id,
        accountId: selected.account.id,
        accountAccessToken: selected.account.accessToken ?? null,
        accountApiToken: (selected.account as { apiToken?: string | null }).apiToken ?? null,
        siteApiKey: selected.site.apiKey ?? null,
        modelName,
        downstreamFormat: 'responses' as const,
        requestedModelHint: requestedModel,
        requestCapabilities: {
          hasNonImageFileInput,
          conversationFileSummary,
          wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
        },
      };
      const buildProviderHeaders = () => (
        buildOauthProviderHeaders({
          extraConfig: typeof selected.account.extraConfig === 'string' ? selected.account.extraConfig : null,
          downstreamHeaders: request.headers as Record<string, unknown>,
        })
      );
      const buildEndpointRequest = (endpoint: 'chat' | 'messages' | 'responses') => {
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
          openaiBody: openAiBody,
          downstreamFormat: 'responses',
          responsesOriginalBody: normalizedResponsesBody,
          downstreamHeaders: request.headers as Record<string, unknown>,
          providerHeaders: buildProviderHeaders(),
        });
        const upstreamPath = (
          isCompactRequest && endpoint === 'responses'
            ? `${endpointRequest.path}/compact`
            : endpointRequest.path
        );
        return {
          endpoint,
          path: upstreamPath,
          headers: endpointRequest.headers,
          body: endpointRequest.body as Record<string, unknown>,
          runtime: endpointRequest.runtime,
        };
      };
      const channelProxyUrl = resolveChannelProxyUrl(selected.site, selected.account.extraConfig);
      const dispatchRequest = (compatibilityRequest: BuiltEndpointRequest, targetUrl?: string) => (
        dispatchRuntimeRequest({
          siteUrl: selected.site.url,
          targetUrl,
          request: compatibilityRequest,
          buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(selected.site, {
            method: 'POST',
            headers: requestForFetch.headers,
            body: JSON.stringify(requestForFetch.body),
          }, channelProxyUrl),
        })
      );
      const endpointStrategy = openAiResponsesTransformer.compatibility.createEndpointStrategy({
        isStream: isStream || isCodexSite,
        requiresNativeResponsesFileUrl,
        dispatchRequest,
      });
      const tryRecover = async (ctx: Parameters<NonNullable<typeof endpointStrategy.tryRecover>>[0]) => {
        if (oauth && shouldRefreshOauthResponsesRequest({
          oauthProvider: oauth.provider,
          status: ctx.response.status,
          response: ctx.response,
          rawErrText: ctx.rawErrText || '',
        })) {
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

        const upstream = endpointResult.upstream;
        const successfulUpstreamPath = endpointResult.upstreamPath;
        const finalizeStreamSuccess = async (parsedUsage: UsageSummary, latency: number) => {
          let usageForLog = {
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
          };
          let estimatedCost = 0;
          let billingDetails: unknown = null;

          try {
            const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
              site: selected.site,
              account: selected.account,
              tokenValue: selected.tokenValue || '',
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
            usageForLog = {
              promptTokens: resolvedUsage.promptTokens,
              completionTokens: resolvedUsage.completionTokens,
              totalTokens: resolvedUsage.totalTokens,
            };
            const billing = await resolveProxyLogBilling({
              site: selected.site,
              account: selected.account,
              modelName: selected.actualModel || requestedModel,
              parsedUsage,
              resolvedUsage,
            });
            estimatedCost = billing.estimatedCost;
            billingDetails = billing.billingDetails;
          } catch (error) {
            console.error('[responses] post-stream bookkeeping failed:', error);
          }

          try {
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
              usageForLog.promptTokens,
              usageForLog.completionTokens,
              usageForLog.totalTokens,
              estimatedCost,
              billingDetails,
              successfulUpstreamPath,
              clientContext,
              downstreamApiKeyId,
            );
          } catch (error) {
            console.error('[responses] post-stream success logging failed:', error);
          }
        };

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

          let parsedUsage: UsageSummary = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            promptTokensIncludeCache: null,
          };
          const writeLines = (lines: string[]) => {
            for (const line of lines) reply.raw.write(line);
          };
          const streamSession = openAiResponsesTransformer.proxyStream.createSession({
            modelName,
            successfulUpstreamPath,
            strictTerminalEvents: Object.entries(request.headers as Record<string, unknown>)
              .some(([rawKey, rawValue]) => rawKey.trim().toLowerCase() === 'x-metapi-responses-websocket-transport'
                && String(rawValue).trim() === '1'),
            getUsage: () => parsedUsage,
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

          if (!upstreamContentType.includes('text/event-stream')) {
            const rawText = await upstream.text();
            if (looksLikeResponsesSseText(rawText)) {
              startSseResponse();
              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                reply.raw,
              );
              const latency = Date.now() - startTime;
              if (streamResult.status === 'failed') {
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

              await finalizeStreamSuccess(parsedUsage, latency);
              return { ok: true, response: upstream, latencyMs: latency };
            }

            let upstreamData: unknown = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
            if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
              upstreamData = unwrapGeminiCliPayload(upstreamData);
            }

            parsedUsage = parseProxyUsage(upstreamData);
            const latency = Date.now() - startTime;
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
                  rawErrorText: failure.reason,
                };
              }

              return {
                ok: false,
                action: 'stop',
                status: failure.status,
                rawErrorText: failure.reason,
              };
            }

            startSseResponse();
            const streamResult = streamSession.consumeUpstreamFinalPayload(upstreamData, rawText, reply.raw);
            if (streamResult.status === 'failed') {
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

            await finalizeStreamSuccess(parsedUsage, latency);
            return { ok: true, response: upstream, latencyMs: latency };
          }

          startSseResponse();

          const upstreamReader = upstream.body?.getReader();
          const baseReader = String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli' && upstreamReader
            ? createGeminiCliStreamReader(upstreamReader)
            : upstreamReader;
          let rawText = '';
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

          const latency = Date.now() - startTime;
          if (streamResult.status === 'failed') {
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

          await finalizeStreamSuccess(parsedUsage, latency);
          return { ok: true, response: upstream, latencyMs: latency };
        }

        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        let rawText = '';
        let upstreamData: unknown;
        if (
          upstreamContentType.includes('text/event-stream')
          && (
            successfulUpstreamPath.endsWith('/responses')
            || successfulUpstreamPath.endsWith('/responses/compact')
          )
        ) {
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
              rawErrorText: failure.reason,
            };
          }

          return {
            ok: false,
            action: 'stop',
            status: failure.status,
            rawErrorText: failure.reason,
          };
        }

        const normalized = openAiResponsesTransformer.transformFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = openAiResponsesTransformer.outbound.serializeFinal({
          upstreamPayload: upstreamData,
          normalized,
          usage: parsedUsage,
          serializationMode: isCompactRequest ? 'compact' : 'response',
        });
        const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
          site: selected.site,
          account: selected.account,
          tokenValue: selected.tokenValue || '',
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
          !isStream && responseCacheKey ? { cacheStatus: 'miss', cacheSavedCost: estimatedCost } : null,
        );
        if (responseCacheKey && !isStream) {
          writeResponseCache(responseCacheKey, requestedModel, {
            body: JSON.stringify(downstreamData),
            isStream: false,
            promptTokens: resolvedUsage.promptTokens,
            completionTokens: resolvedUsage.completionTokens,
            estimatedCost,
          }).catch(() => {});
        }
        reply.header('X-Cache', 'MISS').send(downstreamData);
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

  if (responseCacheKey && !isStream) {
    const stale = await lookupStaleResponseCache(responseCacheKey, config.responseCacheStaleIfErrorMs);
    if (stale) {
      await logProxy(
        {
          channel: { routeId: null, id: null },
          account: { id: null, username: 'cache' },
          actualModel: requestedModel,
          site: { name: '本地缓存', url: '', platform: 'cache' },
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
    console.warn('[proxy/responses] failed to write proxy log', error);
  }
}
