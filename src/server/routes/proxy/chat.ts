import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { tokenRouter } from '../../services/tokenRouter.js';
import { db, schema } from '../../db/index.js';
import { fetch } from 'undici';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { estimateProxyCost } from '../../services/modelPricingService.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { withExplicitProxyRequestInit } from '../../services/siteProxy.js';
import {
  type DownstreamFormat,
  createStreamTransformContext,
  createClaudeDownstreamContext,
  parseDownstreamChatRequest,
  pullSseEventsWithDone,
  normalizeUpstreamStreamEvent,
  serializeNormalizedStreamEvent,
  serializeStreamDone,
  normalizeUpstreamFinalResponse,
  serializeFinalResponse,
  buildSyntheticOpenAiChunks,
} from './chatFormats.js';
import {
  buildMinimalJsonHeadersForCompatibility,
  buildUpstreamEndpointRequest,
  isEndpointDowngradeError,
  isUnsupportedMediaTypeError,
  resolveUpstreamEndpointCandidates,
} from './upstreamEndpoint.js';
import {
  ensureModelAllowedForDownstreamKey,
  getDownstreamRoutingPolicy,
  recordDownstreamCostUsage,
} from './downstreamPolicy.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { executeEndpointFlow, withUpstreamPath } from './endpointFlow.js';

const MAX_RETRIES = 2;
const CLAUDE_SSE_EVENT_NAMES = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error',
]);

function shouldRetryClaudeMessagesWithNormalizedBody(
  downstreamFormat: DownstreamFormat,
  endpointPath: string,
  status: number,
  upstreamErrorText: string,
): boolean {
  if (downstreamFormat !== 'claude') return false;
  if (!endpointPath.includes('/v1/messages')) return false;
  if (status < 400 || status >= 500) return false;
  return /messages\s+is\s+required/i.test(upstreamErrorText);
}

function isMessagesRequiredError(upstreamErrorText: string): boolean {
  return /messages\s+is\s+required/i.test(upstreamErrorText);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isClaudeSseEventName(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_SSE_EVENT_NAMES.has(value);
}

function serializeRawSseEvent(event: string, data: string): string {
  const dataLines = data.split('\n').map((line) => `data: ${line}`).join('\n');
  if (event) {
    return `event: ${event}\n${dataLines}\n\n`;
  }
  return `${dataLines}\n\n`;
}

function syncClaudeStreamStateFromRawEvent(
  eventName: string,
  parsedPayload: unknown,
  streamContext: { id: string; model: string },
  claudeContext: { messageStarted: boolean; contentBlockStarted: boolean; doneSent: boolean },
) {
  if (eventName === 'message_start') {
    claudeContext.messageStarted = true;
    if (isRecord(parsedPayload) && isRecord(parsedPayload.message)) {
      const message = parsedPayload.message;
      if (typeof message.id === 'string' && message.id.trim().length > 0) {
        streamContext.id = message.id;
      }
      if (typeof message.model === 'string' && message.model.trim().length > 0) {
        streamContext.model = message.model;
      }
    }
    return;
  }

  if (eventName === 'content_block_start') {
    claudeContext.contentBlockStarted = true;
    return;
  }

  if (eventName === 'content_block_stop') {
    claudeContext.contentBlockStarted = false;
    return;
  }

  if (eventName === 'message_stop') {
    claudeContext.doneSent = true;
  }
}

export async function chatProxyRoute(app: FastifyInstance) {
  app.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) =>
    handleChatProxyRequest(request, reply, 'openai'));
}

export async function claudeMessagesProxyRoute(app: FastifyInstance) {
  app.post('/v1/messages', async (request: FastifyRequest, reply: FastifyReply) =>
    handleChatProxyRequest(request, reply, 'claude'));
}

async function handleChatProxyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamFormat: DownstreamFormat,
) {
  const parsedRequest = parseDownstreamChatRequest(request.body, downstreamFormat);
  if (parsedRequest.error) {
    return reply.code(parsedRequest.error.statusCode).send(parsedRequest.error.payload);
  }

  const { requestedModel, isStream, upstreamBody, claudeOriginalBody } = parsedRequest.value!;
  const downstreamPath = downstreamFormat === 'claude' ? '/v1/messages' : '/v1/chat/completions';
  if (!ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
  const downstreamPolicy = getDownstreamRoutingPolicy(request);

  const excludeChannelIds: number[] = [];
  let retryCount = 0;

  while (retryCount <= MAX_RETRIES) {
    let selected = retryCount === 0
      ? tokenRouter.selectChannel(requestedModel, downstreamPolicy)
      : tokenRouter.selectNextChannel(requestedModel, excludeChannelIds, downstreamPolicy);

    if (!selected && retryCount === 0) {
      await refreshModelsAndRebuildRoutes();
      selected = tokenRouter.selectChannel(requestedModel, downstreamPolicy);
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

    const modelName = selected.actualModel || requestedModel;
    const endpointCandidates = await resolveUpstreamEndpointCandidates(
      {
        site: selected.site,
        account: selected.account,
      },
      modelName,
      downstreamFormat,
      requestedModel,
    );
    let startTime = Date.now();

    try {
      const endpointResult = await executeEndpointFlow({
        siteUrl: selected.site.url,
        proxyUrl: selected.site.proxyUrl,
        endpointCandidates,
        buildRequest: (endpoint) => {
          const endpointRequest = buildUpstreamEndpointRequest({
            endpoint,
            modelName,
            stream: isStream,
            tokenValue: selected.tokenValue,
            sitePlatform: selected.site.platform,
            siteUrl: selected.site.url,
            openaiBody: upstreamBody,
            downstreamFormat,
            claudeOriginalBody,
            downstreamHeaders: request.headers as Record<string, unknown>,
          });
          return {
            endpoint,
            path: endpointRequest.path,
            headers: endpointRequest.headers,
            body: endpointRequest.body as Record<string, unknown>,
          };
        },
        tryRecover: async (ctx) => {
          if (shouldRetryClaudeMessagesWithNormalizedBody(
            downstreamFormat,
            ctx.request.path,
            ctx.response.status,
            ctx.rawErrText,
          )) {
            const normalizedClaudeRequest = buildUpstreamEndpointRequest({
              endpoint: ctx.request.endpoint,
              modelName,
              stream: isStream,
              tokenValue: selected.tokenValue,
              sitePlatform: selected.site.platform,
              siteUrl: selected.site.url,
              openaiBody: upstreamBody,
              downstreamFormat,
              claudeOriginalBody: undefined,
              downstreamHeaders: request.headers as Record<string, unknown>,
            });
            const normalizedTargetUrl = `${selected.site.url}${normalizedClaudeRequest.path}`;
            const normalizedResponse = await fetch(normalizedTargetUrl, withExplicitProxyRequestInit(selected.site.proxyUrl, {
              method: 'POST',
              headers: normalizedClaudeRequest.headers,
              body: JSON.stringify(normalizedClaudeRequest.body),
            }));

            if (normalizedResponse.ok) {
              return {
                upstream: normalizedResponse,
                upstreamPath: normalizedClaudeRequest.path,
              };
            }

            ctx.request = {
              ...ctx.request,
              path: normalizedClaudeRequest.path,
              headers: normalizedClaudeRequest.headers,
              body: normalizedClaudeRequest.body as Record<string, unknown>,
            };
            ctx.response = normalizedResponse;
            ctx.rawErrText = await normalizedResponse.text().catch(() => 'unknown error');
          }

          if (!isUnsupportedMediaTypeError(ctx.response.status, ctx.rawErrText)) {
            return null;
          }

          const minimalHeaders = buildMinimalJsonHeadersForCompatibility({
            headers: ctx.request.headers,
            endpoint: ctx.request.endpoint,
            stream: isStream,
          });
          const normalizedCurrentHeaders = Object.fromEntries(
            Object.entries(ctx.request.headers).map(([key, value]) => [key.toLowerCase(), value]),
          );
          if (JSON.stringify(minimalHeaders) === JSON.stringify(normalizedCurrentHeaders)) {
            return null;
          }

          const minimalResponse = await fetch(ctx.targetUrl, withExplicitProxyRequestInit(selected.site.proxyUrl, {
            method: 'POST',
            headers: minimalHeaders,
            body: JSON.stringify(ctx.request.body),
          }));

          if (minimalResponse.ok) {
            return {
              upstream: minimalResponse,
              upstreamPath: ctx.request.path,
            };
          }

          ctx.request = {
            ...ctx.request,
            headers: minimalHeaders,
          };
          ctx.response = minimalResponse;
          ctx.rawErrText = await minimalResponse.text().catch(() => 'unknown error');
          return null;
        },
        shouldDowngrade: (ctx) => (
          isEndpointDowngradeError(ctx.response.status, ctx.rawErrText)
          || isMessagesRequiredError(ctx.rawErrText)
        ),
        onDowngrade: (ctx) => {
          logProxy(
            selected,
            requestedModel,
            'failed',
            ctx.response.status,
            Date.now() - startTime,
            ctx.errText,
            retryCount,
            downstreamPath,
          );
        },
      });

      if (!endpointResult.ok) {
        const status = endpointResult.status || 502;
        const errText = endpointResult.errText || 'unknown error';
        tokenRouter.recordFailure(selected.channel.id);
        logProxy(selected, requestedModel, 'failed', status, Date.now() - startTime, errText, retryCount, downstreamPath);

        if (isTokenExpiredError({ status, message: errText })) {
          await reportTokenExpired({
            accountId: selected.account.id,
            username: selected.account.username,
            siteName: selected.site.name,
            detail: `HTTP ${status}`,
          });
        }

        if (shouldRetryProxyRequest(status, errText) && retryCount < MAX_RETRIES) {
          retryCount += 1;
          continue;
        }

        await reportProxyAllFailed({
          model: requestedModel,
          reason: `upstream returned HTTP ${status}`,
        });

        return reply.code(status).send({
          error: { message: errText, type: 'upstream_error' },
        });
      }

      const upstream = endpointResult.upstream;
      const successfulUpstreamPath = endpointResult.upstreamPath;

      if (isStream) {
        reply.hijack();
        reply.raw.statusCode = 200;
        reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');

        const streamContext = createStreamTransformContext(modelName);
        const claudeContext = createClaudeDownstreamContext();
        let parsedUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        const writeLines = (lines: string[]) => {
          for (const line of lines) {
            reply.raw.write(line);
          }
        };

        const writeDone = () => {
          writeLines(serializeStreamDone(downstreamFormat, streamContext, claudeContext));
        };

        const emitNormalizedFinalAsStream = (upstreamData: unknown, fallbackText = '') => {
          const normalizedFinal = normalizeUpstreamFinalResponse(upstreamData, modelName, fallbackText);
          streamContext.id = normalizedFinal.id;
          streamContext.model = normalizedFinal.model;
          streamContext.created = normalizedFinal.created;

          if (downstreamFormat === 'openai') {
            const syntheticChunks = buildSyntheticOpenAiChunks(normalizedFinal);
            for (const chunk of syntheticChunks) {
              reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            return;
          }

          writeLines(serializeNormalizedStreamEvent('claude', { role: 'assistant' }, streamContext, claudeContext));

          const combinedText = [normalizedFinal.reasoningContent, normalizedFinal.content]
            .filter((item) => typeof item === 'string' && item.trim().length > 0)
            .join('\n\n');

          if (combinedText) {
            writeLines(serializeNormalizedStreamEvent('claude', {
              contentDelta: combinedText,
            }, streamContext, claudeContext));
          }

          writeLines(serializeNormalizedStreamEvent('claude', {
            finishReason: normalizedFinal.finishReason,
          }, streamContext, claudeContext));
        };

        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        if (!upstreamContentType.includes('text/event-stream')) {
          const fallbackText = await upstream.text();
          let fallbackData: unknown = null;
          try {
            fallbackData = JSON.parse(fallbackText);
          } catch {
            fallbackData = fallbackText;
          }

          parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(fallbackData));
          emitNormalizedFinalAsStream(fallbackData, fallbackText);
          writeDone();
          reply.raw.end();

          const latency = Date.now() - startTime;
          const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
            site: selected.site,
            account: selected.account,
            tokenValue: selected.tokenValue,
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

          let estimatedCost = await estimateProxyCost({
            site: selected.site,
            account: selected.account,
            modelName,
            promptTokens: resolvedUsage.promptTokens,
            completionTokens: resolvedUsage.completionTokens,
            totalTokens: resolvedUsage.totalTokens,
          });

          if (resolvedUsage.estimatedCostFromQuota > 0 && (resolvedUsage.recoveredFromSelfLog || estimatedCost <= 0)) {
            estimatedCost = resolvedUsage.estimatedCostFromQuota;
          }

          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
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
            successfulUpstreamPath,
          );
          return;
        }

        const reader = upstream.body?.getReader();
        if (!reader) {
          writeDone();
          reply.raw.end();
          return;
        }

        const decoder = new TextDecoder();
        let sseBuffer = '';
        let shouldTerminateEarly = false;

        const consumeSseBuffer = (incoming: string): string => {
          const pulled = pullSseEventsWithDone(incoming);
          for (const eventBlock of pulled.events) {
            if (eventBlock.data === '[DONE]') {
              writeDone();
              shouldTerminateEarly = true;
              continue;
            }

            let parsedPayload: unknown = null;
            try {
              parsedPayload = JSON.parse(eventBlock.data);
            } catch {
              parsedPayload = null;
            }

            if (parsedPayload && typeof parsedPayload === 'object') {
              parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(parsedPayload));

              if (downstreamFormat === 'claude') {
                const payloadType = (isRecord(parsedPayload) && typeof parsedPayload.type === 'string')
                  ? parsedPayload.type
                  : '';
                const claudeEventName = isClaudeSseEventName(eventBlock.event)
                  ? eventBlock.event
                  : (isClaudeSseEventName(payloadType) ? payloadType : '');

                if (claudeEventName) {
                  syncClaudeStreamStateFromRawEvent(
                    claudeEventName,
                    parsedPayload,
                    streamContext,
                    claudeContext,
                  );
                  reply.raw.write(serializeRawSseEvent(claudeEventName, eventBlock.data));
                  if (claudeContext.doneSent) {
                    shouldTerminateEarly = true;
                    break;
                  }
                  continue;
                }
              }

              const normalizedEvent = normalizeUpstreamStreamEvent(parsedPayload, streamContext, modelName);
              writeLines(serializeNormalizedStreamEvent(
                downstreamFormat,
                normalizedEvent,
                streamContext,
                claudeContext,
              ));
              if (downstreamFormat === 'claude' && claudeContext.doneSent) {
                shouldTerminateEarly = true;
                break;
              }
              if (downstreamFormat === 'openai' && streamContext.doneSent) {
                shouldTerminateEarly = true;
                break;
              }
              continue;
            }

            if (downstreamFormat === 'openai') {
              reply.raw.write(`data: ${eventBlock.data}\n\n`);
            } else {
              writeLines(serializeNormalizedStreamEvent('claude', {
                contentDelta: eventBlock.data,
              }, streamContext, claudeContext));
              if (claudeContext.doneSent) {
                shouldTerminateEarly = true;
                break;
              }
            }
          }

          return pulled.rest;
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            sseBuffer += decoder.decode(value, { stream: true });
            sseBuffer = consumeSseBuffer(sseBuffer);
            if (shouldTerminateEarly) {
              await reader.cancel().catch(() => {});
              break;
            }
          }

          if (!shouldTerminateEarly) {
            sseBuffer += decoder.decode();
          }
          if (!shouldTerminateEarly && sseBuffer.trim().length > 0) {
            sseBuffer = consumeSseBuffer(`${sseBuffer}\n\n`);
          }
        } finally {
          reader.releaseLock();
          writeDone();
          reply.raw.end();
        }

        const latency = Date.now() - startTime;
        const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
          site: selected.site,
          account: selected.account,
          tokenValue: selected.tokenValue,
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

        let estimatedCost = await estimateProxyCost({
          site: selected.site,
          account: selected.account,
          modelName,
          promptTokens: resolvedUsage.promptTokens,
          completionTokens: resolvedUsage.completionTokens,
          totalTokens: resolvedUsage.totalTokens,
        });

        if (resolvedUsage.estimatedCostFromQuota > 0 && (resolvedUsage.recoveredFromSelfLog || estimatedCost <= 0)) {
          estimatedCost = resolvedUsage.estimatedCostFromQuota;
        }

        tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
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
          successfulUpstreamPath,
        );
        return;
      }

      const rawText = await upstream.text();
      let upstreamData: unknown = rawText;
      try {
        upstreamData = JSON.parse(rawText);
      } catch {
        upstreamData = rawText;
      }

      const latency = Date.now() - startTime;
      const parsedUsage = parseProxyUsage(upstreamData);
      const normalizedFinal = normalizeUpstreamFinalResponse(upstreamData, modelName, rawText);
      const downstreamResponse = serializeFinalResponse(downstreamFormat, normalizedFinal, parsedUsage);

      const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
        site: selected.site,
        account: selected.account,
        tokenValue: selected.tokenValue,
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

      let estimatedCost = await estimateProxyCost({
        site: selected.site,
        account: selected.account,
        modelName,
        promptTokens: resolvedUsage.promptTokens,
        completionTokens: resolvedUsage.completionTokens,
        totalTokens: resolvedUsage.totalTokens,
      });

      if (resolvedUsage.estimatedCostFromQuota > 0 && (resolvedUsage.recoveredFromSelfLog || estimatedCost <= 0)) {
        estimatedCost = resolvedUsage.estimatedCostFromQuota;
      }

      tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
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
        successfulUpstreamPath,
      );

      return reply.send(downstreamResponse);
    } catch (err: any) {
      tokenRouter.recordFailure(selected.channel.id);
      logProxy(selected, requestedModel, 'failed', 0, Date.now() - startTime, err?.message || 'network error', retryCount, downstreamPath);

      if (retryCount < MAX_RETRIES) {
        retryCount += 1;
        continue;
      }

      await reportProxyAllFailed({
        model: requestedModel,
        reason: err?.message || 'network failure',
      });

      return reply.code(502).send({
        error: {
          message: `Upstream error: ${err?.message || 'network failure'}`,
          type: 'upstream_error',
        },
      });
    }
  }
}

function logProxy(
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
  upstreamPath: string | null = null,
) {
  try {
    const normalizedErrorMessage = composeProxyLogMessage({
      downstreamPath,
      upstreamPath,
      errorMessage,
    });
    db.insert(schema.proxyLogs).values({
      routeId: selected.channel.routeId,
      channelId: selected.channel.id,
      accountId: selected.account.id,
      modelRequested,
      modelActual: selected.actualModel,
      status,
      httpStatus,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCost,
      errorMessage: normalizedErrorMessage,
      retryCount,
    }).run();
  } catch (error) {
    console.warn('[proxy/chat] failed to write proxy log', error);
  }
}
