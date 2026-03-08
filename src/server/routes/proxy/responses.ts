import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { db, schema } from '../../db/index.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { resolveProxyUrlForSite, withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { type NormalizedStreamEvent } from '../../transformers/shared/normalized.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import { serializeResponsesFinalPayload } from '../../transformers/openai/responses/outbound.js';
import { convertResponsesBodyToOpenAiBody } from '../../transformers/openai/responses/conversion.js';
import {
  completeResponsesStream,
  createOpenAiResponsesAggregateState,
  failResponsesStream,
  serializeConvertedResponsesEvents,
} from '../../transformers/openai/responses/aggregator.js';
import {
  buildMinimalJsonHeadersForCompatibility,
  buildUpstreamEndpointRequest,
  isEndpointDowngradeError,
  isUnsupportedMediaTypeError,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpoint.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { executeEndpointFlow, withUpstreamPath } from './endpointFlow.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { resolveProxyLogBilling } from './proxyBilling.js';

const MAX_RETRIES = 2;

function shouldDowngradeFromChatToMessagesForResponses(
  endpointPath: string,
  status: number,
  upstreamErrorText: string,
): boolean {
  if (!endpointPath.includes('/chat/completions')) return false;
  if (status < 400 || status >= 500) return false;
  return /messages\s+is\s+required/i.test(upstreamErrorText);
}

function parseUpstreamErrorShape(rawText: string): {
  type: string;
  code: string;
  message: string;
} {
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const error = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : parsed;
    return {
      type: typeof error.type === 'string' ? error.type.trim().toLowerCase() : '',
      code: typeof error.code === 'string' ? error.code.trim().toLowerCase() : '',
      message: typeof error.message === 'string' ? error.message.trim() : '',
    };
  } catch {
    return { type: '', code: '', message: '' };
  }
}

function stripResponsesMetadata(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!Object.prototype.hasOwnProperty.call(body, 'metadata')) return null;
  const next = { ...body };
  delete next.metadata;
  return next;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildCoreResponsesBody(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) return null;
  if (body.input === undefined) return null;

  const core: Record<string, unknown> = {
    model,
    input: body.input,
    stream: body.stream === true,
  };

  const maxOutputTokens = toFiniteNumber(body.max_output_tokens);
  if (maxOutputTokens !== null && maxOutputTokens > 0) {
    core.max_output_tokens = Math.trunc(maxOutputTokens);
  }

  const temperature = toFiniteNumber(body.temperature);
  if (temperature !== null) core.temperature = temperature;

  const topP = toFiniteNumber(body.top_p);
  if (topP !== null) core.top_p = topP;

  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  if (instructions) core.instructions = instructions;

  return core;
}

function buildStrictResponsesBody(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) return null;
  if (body.input === undefined) return null;

  return {
    model,
    input: body.input,
    stream: body.stream === true,
  };
}

function buildResponsesCompatibilityBodies(
  body: Record<string, unknown>,
): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  try {
    const originalKey = JSON.stringify(body);
    if (originalKey) seen.add(originalKey);
  } catch {
    // ignore non-serializable bodies
  }
  const push = (next: Record<string, unknown> | null) => {
    if (!next) return;
    let key = '';
    try {
      key = JSON.stringify(next);
    } catch {
      return;
    }
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(next);
  };

  push(stripResponsesMetadata(body));
  push(buildCoreResponsesBody(body));
  push(buildStrictResponsesBody(body));
  return candidates;
}

function buildResponsesCompatibilityHeaderCandidates(
  headers: Record<string, string>,
  stream: boolean,
): Record<string, string>[] {
  const candidates: Record<string, string>[] = [];
  const seen = new Set<string>();
  const push = (next: Record<string, string>) => {
    const normalizedEntries = Object.entries(next)
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify(normalizedEntries);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(Object.fromEntries(normalizedEntries));
  };

  push(headers);

  const minimal: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (
      key === 'authorization'
      || key === 'x-api-key'
      || key === 'content-type'
      || key === 'accept'
    ) {
      minimal[key] = rawValue;
    }
  }
  if (!minimal['content-type']) minimal['content-type'] = 'application/json';
  if (stream && !minimal.accept) minimal.accept = 'text/event-stream';
  push(minimal);

  return candidates;
}

function shouldRetryResponsesCompatibility(input: {
  endpoint: UpstreamEndpoint;
  status: number;
  rawErrText: string;
}): boolean {
  if (input.endpoint !== 'responses') return false;
  if (input.status !== 400) return false;
  const parsedError = parseUpstreamErrorShape(input.rawErrText);
  const type = parsedError.type.trim().toLowerCase();
  const code = parsedError.code.trim().toLowerCase();
  const message = parsedError.message.trim().toLowerCase();
  const compact = `${type} ${code} ${message}`.trim();
  const rawCompact = (input.rawErrText || '').toLowerCase();

  // Authentication/authorization failures should not enter compatibility retries.
  if (
    compact.includes('invalid_api_key')
    || compact.includes('authentication')
    || compact.includes('unauthorized')
    || compact.includes('forbidden')
    || compact.includes('insufficient_quota')
    || compact.includes('rate_limit')
  ) {
    return false;
  }

  if (type === 'upstream_error' || code === 'upstream_error') return true;
  if (message === 'upstream_error' || message === 'upstream request failed') return true;
  if (rawCompact.includes('upstream_error')) return true;

  // Many sub2api-compatible gateways return generic 400 for field incompatibilities.
  // Retry with progressively stricter payload/header candidates to maximize compatibility.
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter((item) => item.length > 0)
      .join('\n');
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.input_text === 'string') return value.input_text;
    if (typeof value.output_text === 'string') return value.output_text;
    if (Array.isArray(value.content)) return normalizeText(value.content);
  }
  return '';
}

type UsageSummary = ReturnType<typeof parseProxyUsage>;

export async function responsesProxyRoute(app: FastifyInstance) {
  const handleResponsesRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
    downstreamPath: string,
  ) => {
    const body = request.body as any;
    const requestedModel = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!requestedModel) {
      return reply.code(400).send({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const isCompactRequest = downstreamPath === '/v1/responses/compact';

    const isStream = body.stream === true;
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

      const modelName = selected.actualModel || requestedModel;
      const openAiBody = convertResponsesBodyToOpenAiBody(body, modelName, isStream);
      const endpointCandidates = await resolveUpstreamEndpointCandidates(
        {
          site: selected.site,
          account: selected.account,
        },
        modelName,
        'responses',
        requestedModel,
      );
      if (endpointCandidates.length === 0) {
        endpointCandidates.push('responses', 'chat', 'messages');
      }

      const startTime = Date.now();

      try {
        const endpointResult = await executeEndpointFlow({
          siteUrl: selected.site.url,
          proxyUrl: resolveProxyUrlForSite(selected.site),
          endpointCandidates,
          buildRequest: (endpoint) => {
            const endpointRequest = buildUpstreamEndpointRequest({
              endpoint,
              modelName,
              stream: isStream,
              tokenValue: selected.tokenValue,
              sitePlatform: selected.site.platform,
              siteUrl: selected.site.url,
              openaiBody: openAiBody,
              downstreamFormat: 'responses',
              responsesOriginalBody: body,
              downstreamHeaders: request.headers as Record<string, unknown>,
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
            };
          },
          tryRecover: async (ctx) => {
            if (shouldRetryResponsesCompatibility({
              endpoint: ctx.request.endpoint,
              status: ctx.response.status,
              rawErrText: ctx.rawErrText,
            })) {
              const compatibilityBodies = buildResponsesCompatibilityBodies(ctx.request.body);
              const compatibilityHeaders = buildResponsesCompatibilityHeaderCandidates(
                ctx.request.headers,
                isStream,
              );

              for (const compatibilityHeadersCandidate of compatibilityHeaders) {
                for (const compatibilityBody of compatibilityBodies) {
                  const compatibilityResponse = await fetch(
                    ctx.targetUrl,
                    withSiteRecordProxyRequestInit(selected.site, {
                      method: 'POST',
                      headers: compatibilityHeadersCandidate,
                      body: JSON.stringify(compatibilityBody),
                    }),
                  );
                  if (compatibilityResponse.ok) {
                    return {
                      upstream: compatibilityResponse,
                      upstreamPath: ctx.request.path,
                    };
                  }

                  ctx.request = {
                    ...ctx.request,
                    headers: compatibilityHeadersCandidate,
                    body: compatibilityBody,
                  };
                  ctx.response = compatibilityResponse;
                  ctx.rawErrText = await compatibilityResponse.text().catch(() => 'unknown error');
                }
              }
            }

            if (!isUnsupportedMediaTypeError(ctx.response.status, ctx.rawErrText)) {
              return null;
            }

            const minimalHeaders = buildMinimalJsonHeadersForCompatibility({
              headers: ctx.request.headers,
              endpoint: ctx.request.endpoint,
              stream: isStream,
            });
            const minimalResponse = await fetch(
              ctx.targetUrl,
              withSiteRecordProxyRequestInit(selected.site, {
                method: 'POST',
                headers: minimalHeaders,
                body: JSON.stringify(ctx.request.body),
              }),
            );
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
            ctx.response.status >= 500
            || isEndpointDowngradeError(ctx.response.status, ctx.rawErrText)
            || shouldDowngradeFromChatToMessagesForResponses(
              ctx.request.path,
              ctx.response.status,
              ctx.rawErrText,
            )
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
          return reply.code(status).send({ error: { message: errText, type: 'upstream_error' } });
        }

        const upstream = endpointResult.upstream;
        const successfulUpstreamPath = endpointResult.upstreamPath;

        if (isStream) {
          reply.raw.statusCode = 200;
          reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
          reply.raw.setHeader('Connection', 'keep-alive');
          reply.raw.setHeader('X-Accel-Buffering', 'no');

          const reader = upstream.body?.getReader();
          if (!reader) {
            reply.raw.end();
            return;
          }

          const decoder = new TextDecoder();
          let parsedUsage: UsageSummary = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            promptTokensIncludeCache: null,
          };
          let sseBuffer = '';

          const passthroughResponsesStream = successfulUpstreamPath === '/v1/responses';
          const streamContext = openAiResponsesTransformer.createStreamContext(modelName);
          const responsesState = createOpenAiResponsesAggregateState(modelName);

          const writeLines = (lines: string[]) => {
            for (const line of lines) reply.raw.write(line);
          };

          const consumeSseBuffer = (incoming: string): string => {
             const pulled = openAiResponsesTransformer.pullSseEvents(incoming);
            for (const eventBlock of pulled.events) {
              if (eventBlock.data === '[DONE]') {
                if (passthroughResponsesStream) {
                  reply.raw.write('data: [DONE]\n\n');
                } else if (!responsesState.completed) {
                  writeLines(completeResponsesStream(responsesState, streamContext, parsedUsage));
                }
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
              }

              if (passthroughResponsesStream) {
                const eventName = eventBlock.event ? `event: ${eventBlock.event}\n` : '';
                reply.raw.write(`${eventName}data: ${eventBlock.data}\n\n`);
                continue;
              }

              const payloadType = (isRecord(parsedPayload) && typeof parsedPayload.type === 'string')
                ? parsedPayload.type
                : '';
              const isFailureEvent = (
                eventBlock.event === 'error'
                || eventBlock.event === 'response.failed'
                || payloadType === 'error'
                || payloadType === 'response.failed'
              );
              if (isFailureEvent) {
                writeLines(failResponsesStream(responsesState, streamContext, parsedUsage, parsedPayload));
                continue;
              }

              if (parsedPayload && typeof parsedPayload === 'object') {
                const normalizedEvent = openAiResponsesTransformer.transformStreamEvent(parsedPayload, streamContext, modelName);
                writeLines(serializeConvertedResponsesEvents({
                  state: responsesState,
                  streamContext,
                  event: normalizedEvent,
                  usage: parsedUsage,
                }));
                continue;
              }

              writeLines(serializeConvertedResponsesEvents({
                state: responsesState,
                streamContext,
                event: { contentDelta: eventBlock.data },
                usage: parsedUsage,
              }));
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
            }

            sseBuffer += decoder.decode();
            if (sseBuffer.trim().length > 0) {
              sseBuffer = consumeSseBuffer(`${sseBuffer}\n\n`);
            }
          } finally {
            reader.releaseLock();
            if (!passthroughResponsesStream && !responsesState.completed) {
              writeLines(completeResponsesStream(responsesState, streamContext, parsedUsage));
            }
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
          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
          recordDownstreamCostUsage(request, estimatedCost);
          logProxy(
            selected, requestedModel, 'success', 200, latency, null, retryCount, downstreamPath,
            resolvedUsage.promptTokens, resolvedUsage.completionTokens, resolvedUsage.totalTokens, estimatedCost, billingDetails,
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
        const normalized = openAiResponsesTransformer.transformFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = serializeResponsesFinalPayload({
          upstreamPayload: upstreamData,
          normalized,
          usage: parsedUsage,
        });
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

        tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
        recordDownstreamCostUsage(request, estimatedCost);
        logProxy(
          selected, requestedModel, 'success', 200, latency, null, retryCount, downstreamPath,
          resolvedUsage.promptTokens, resolvedUsage.completionTokens, resolvedUsage.totalTokens, estimatedCost, billingDetails,
          successfulUpstreamPath,
        );
        return reply.send(downstreamData);
      } catch (err: any) {
        tokenRouter.recordFailure(selected.channel.id);
        logProxy(selected, requestedModel, 'failed', 0, Date.now() - startTime, err.message, retryCount, downstreamPath);
        if (retryCount < MAX_RETRIES) {
          retryCount += 1;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: err.message || 'network failure',
        });
        return reply.code(502).send({
          error: { message: `Upstream error: ${err.message}`, type: 'upstream_error' },
        });
      }
    }
  };

  app.post('/v1/responses', async (request: FastifyRequest, reply: FastifyReply) =>
    handleResponsesRequest(request, reply, '/v1/responses'));
  app.post('/v1/responses/compact', async (request: FastifyRequest, reply: FastifyReply) =>
    handleResponsesRequest(request, reply, '/v1/responses/compact'));
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
) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    const normalizedErrorMessage = composeProxyLogMessage({
      downstreamPath,
      upstreamPath,
      errorMessage,
    });
    await db.insert(schema.proxyLogs).values({
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
      billingDetails: billingDetails ? JSON.stringify(billingDetails) : null,
      errorMessage: normalizedErrorMessage,
      retryCount,
      createdAt,
    }).run();
  } catch (error) {
    console.warn('[proxy/responses] failed to write proxy log', error);
  }
}
