import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { createCodexWebsocketRuntime, CodexWebsocketRuntimeError } from '../../proxy-core/runtime/codexWebsocketRuntime.js';
import {
  authorizeDownstreamToken,
  consumeManagedKeyRequest,
  isModelAllowedByPolicyOrAllowedRoutes,
  type DownstreamTokenAuthSuccess,
} from '../../services/downstreamApiKeyService.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { insertProxyLogBestEffort, resolveProxyLogRouteContext } from '../../services/proxyLogStore.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { buildOauthProviderHeaders } from '../../services/oauth/service.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from './downstreamClientContext.js';
import { composeProxyLogMessage } from './logPathMeta.js';
import { buildUpstreamEndpointRequest } from './upstreamEndpoint.js';
import type { DownstreamRoutingPolicy } from '../../services/downstreamPolicyTypes.js';

const installedApps = new WeakSet<FastifyInstance>();
const WS_TURN_STATE_HEADER = 'x-codex-turn-state';
const RESPONSES_WEBSOCKET_MODE_HEADER = 'x-metapi-responses-websocket-mode';
const RESPONSES_WEBSOCKET_TRANSPORT_HEADER = 'x-metapi-responses-websocket-transport';
const codexWebsocketRuntime = createCodexWebsocketRuntime();

type SelectedChannel = NonNullable<Awaited<ReturnType<typeof tokenRouter.selectChannel>>>;
type ResponsesWebsocketAuthContext = DownstreamTokenAuthSuccess;
type ProxyUsageSummary = ReturnType<typeof parseProxyUsage>;

type NormalizedResponsesWebsocketRequest =
  | {
    ok: true;
    request: Record<string, unknown>;
    nextRequestSnapshot: Record<string, unknown>;
  }
  | {
    ok: false;
    status: number;
    message: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function headerValueToTrimmedString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

function toBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  }
  return null;
}

function parseExtraConfigRecord(extraConfig: unknown): Record<string, unknown> | null {
  if (typeof extraConfig !== 'string') return null;
  try {
    const parsed = JSON.parse(extraConfig);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function selectedChannelModelMatches(
  selectedChannel: SelectedChannel | null,
  requestModel: string,
): boolean {
  if (!selectedChannel) return false;
  const selectedModel = asTrimmedString(selectedChannel.actualModel).toLowerCase();
  const normalizedRequestModel = asTrimmedString(requestModel).toLowerCase();
  if (!selectedModel || !normalizedRequestModel) return true;
  return selectedModel === normalizedRequestModel;
}

function selectedChannelSupportsCodexWebsocketTransport(
  selectedChannel: SelectedChannel | null,
  requestModel: string,
): boolean {
  if (!selectedChannel) return false;
  const platform = asTrimmedString(selectedChannel.site?.platform).toLowerCase();
  if (platform !== 'codex') return false;
  if (!selectedChannelModelMatches(selectedChannel, requestModel)) return false;

  const extraConfig = parseExtraConfigRecord(selectedChannel.account.extraConfig);
  const oauth = readNestedRecord(extraConfig, 'oauth');
  const providerData = readNestedRecord(oauth, 'providerData');
  const candidateFlags = [
    extraConfig?.websockets,
    readNestedRecord(extraConfig, 'attributes')?.websockets,
    readNestedRecord(extraConfig, 'metadata')?.websockets,
    providerData?.websockets,
    readNestedRecord(providerData, 'attributes')?.websockets,
    readNestedRecord(providerData, 'metadata')?.websockets,
  ];
  for (const candidate of candidateFlags) {
    const parsed = toBooleanLike(candidate);
    if (parsed !== null) return parsed;
  }
  return true;
}

function selectedChannelSupportsIncrementalInput(
  selectedChannel: SelectedChannel | null,
  requestModel: string,
): boolean {
  return selectedChannelSupportsCodexWebsocketTransport(selectedChannel, requestModel);
}

function shouldReuseSelectedChannel(
  selectedChannel: SelectedChannel | null,
  requestModel: string,
): boolean {
  if (!selectedChannel) return false;
  const selectedModel = asTrimmedString(selectedChannel.actualModel).toLowerCase();
  const normalizedRequestModel = asTrimmedString(requestModel).toLowerCase();
  if (!selectedModel || !normalizedRequestModel) return true;
  return selectedModel === normalizedRequestModel;
}

function deriveCodexExplicitSessionId(body: Record<string, unknown>, sessionId: string): string {
  void body;
  return sessionId;
}

function parseJsonObject(raw: RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(raw));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cloneJsonObject<T>(value: T): T {
  return structuredClone(value);
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasMeaningfulContentPart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  const partType = asTrimmedString(part.type).toLowerCase();
  if (partType === 'output_text' || partType === 'text') {
    return hasNonEmptyString(part.text);
  }
  return partType.length > 0;
}

function hasMeaningfulOutputItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const itemType = asTrimmedString(item.type).toLowerCase();
  if (itemType === 'message') {
    return Array.isArray(item.content) && item.content.some((part) => hasMeaningfulContentPart(part));
  }
  if (itemType === 'reasoning') {
    return (
      (Array.isArray(item.summary) && item.summary.some((part) => hasMeaningfulContentPart(part)))
      || hasNonEmptyString(item.encrypted_content)
    );
  }
  return itemType.length > 0;
}

function hasMeaningfulResponsesPayloadOutput(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (hasNonEmptyString(payload.output_text)) return true;
  return Array.isArray(payload.output) && payload.output.some((item) => hasMeaningfulOutputItem(item));
}

function toResponseInputArray(value: unknown): unknown[] {
  return Array.isArray(value) ? cloneJsonObject(value) : [];
}

function normalizeResponsesWebsocketRequest(
  parsed: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null,
  lastResponseOutput: unknown[],
  supportsIncrementalInput: boolean,
): NormalizedResponsesWebsocketRequest {
  const requestType = asTrimmedString(parsed.type);
  if (requestType !== 'response.create' && requestType !== 'response.append') {
    return {
      ok: false,
      status: 400,
      message: `unsupported websocket request type: ${requestType || 'unknown'}`,
    };
  }

  if (!lastRequest) {
    if (requestType !== 'response.create') {
      return {
        ok: false,
        status: 400,
        message: 'websocket request received before response.create',
      };
    }
    const next = cloneJsonObject(parsed);
    delete next.type;
    if (!supportsIncrementalInput && parsed.generate === false) {
      delete next.generate;
    }
    next.stream = true;
    if (!Array.isArray(next.input)) next.input = [];
    const modelName = asTrimmedString(next.model);
    if (!modelName) {
      return {
        ok: false,
        status: 400,
        message: 'missing model in response.create request',
      };
    }
    return {
      ok: true,
      request: next,
      nextRequestSnapshot: cloneJsonObject(next),
    };
  }

  if (!Array.isArray(parsed.input)) {
    return {
      ok: false,
      status: 400,
      message: 'websocket request requires array field: input',
    };
  }

  const next = cloneJsonObject(parsed);
  delete next.type;
  next.stream = true;
  if (!('model' in next) && typeof lastRequest.model === 'string') {
    next.model = lastRequest.model;
  }
  if (!('instructions' in next) && lastRequest.instructions !== undefined) {
    next.instructions = cloneJsonObject(lastRequest.instructions);
  }

  if (supportsIncrementalInput && requestType === 'response.create' && asTrimmedString(parsed.previous_response_id)) {
    return {
      ok: true,
      request: next,
      nextRequestSnapshot: cloneJsonObject(next),
    };
  }

  const mergedInput = [
    ...toResponseInputArray(lastRequest.input),
    ...cloneJsonObject(lastResponseOutput),
    ...cloneJsonObject(parsed.input),
  ];
  delete next.previous_response_id;
  next.input = mergedInput;

  return {
    ok: true,
    request: next,
    nextRequestSnapshot: cloneJsonObject(next),
  };
}

function shouldHandleResponsesWebsocketPrewarmLocally(
  parsed: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null,
  supportsIncrementalInput: boolean,
): boolean {
  if (supportsIncrementalInput || lastRequest) return false;
  if (asTrimmedString(parsed.type) !== 'response.create') return false;
  return parsed.generate === false;
}

function writeResponsesWebsocketError(
  socket: WebSocket,
  status: number,
  message: string,
  errorPayload?: unknown,
) {
  socket.send(JSON.stringify({
    type: 'error',
    status,
    error: isRecord(errorPayload) && isRecord(errorPayload.error)
      ? errorPayload.error
      : {
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
        message,
      },
  }));
}

function synthesizePrewarmResponsePayloads(request: Record<string, unknown>) {
  const responseId = `resp_prewarm_${randomUUID()}`;
  const modelName = asTrimmedString(request.model) || 'unknown';
  const createdAt = Math.floor(Date.now() / 1000);
  return [
    {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'in_progress',
        model: modelName,
        output: [],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'completed',
        model: modelName,
        output: [],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      },
    },
  ];
}

function collectResponsesOutput(payloads: unknown[]): unknown[] {
  const outputByIndex = new Map<number, unknown>();

  for (const payload of payloads) {
    if (!isRecord(payload)) continue;
    const type = asTrimmedString(payload.type);
    if ((type === 'response.output_item.added' || type === 'response.output_item.done')
      && Number.isInteger(payload.output_index)
      && payload.item !== undefined) {
      outputByIndex.set(Number(payload.output_index), cloneJsonObject(payload.item));
      continue;
    }
    if (
      type === 'response.output_text.delta'
      && Number.isInteger(payload.output_index)
      && hasNonEmptyString(payload.delta)
    ) {
      const outputIndex = Number(payload.output_index);
      const existing = outputByIndex.get(outputIndex);
      const nextItem = isRecord(existing)
        ? cloneJsonObject(existing)
        : {
          id: asTrimmedString(payload.item_id) || `msg_${outputIndex}`,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        };
      const content = Array.isArray(nextItem.content) ? [...nextItem.content] : [];
      const textIndex = content.findIndex((part) => isRecord(part) && asTrimmedString(part.type).toLowerCase() === 'output_text');
      if (textIndex >= 0 && isRecord(content[textIndex])) {
        const current = content[textIndex] as Record<string, unknown>;
        content[textIndex] = {
          ...current,
          text: `${typeof current.text === 'string' ? current.text : ''}${String(payload.delta)}`,
        };
      } else {
        content.push({ type: 'output_text', text: String(payload.delta) });
      }
      nextItem.content = content;
      outputByIndex.set(outputIndex, nextItem);
      continue;
    }
    if (type === 'response.completed' && isRecord(payload.response) && Array.isArray(payload.response.output)) {
      payload.response.output.forEach((item, index) => {
        outputByIndex.set(index, cloneJsonObject(item));
      });
    }
  }

  return [...outputByIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value);
}

function collectResponsesUsageFromEvents(payloads: Array<Record<string, unknown>>): ProxyUsageSummary {
  let merged = parseProxyUsage({});
  for (const payload of payloads) {
    merged = mergeProxyUsage(merged, parseProxyUsage(payload));
  }
  return merged;
}

function hasMeaningfulResponsesEventsOutput(payloads: Array<Record<string, unknown>>): boolean {
  return hasMeaningfulResponsesPayloadOutput({
    output: collectResponsesOutput(payloads),
  });
}

async function writeResponsesWebsocketProxyLog(input: {
  selected: SelectedChannel;
  modelRequested: string;
  modelActual: string;
  status: 'success' | 'failed';
  httpStatus: number;
  latencyMs: number;
  errorMessage: string | null;
  retryCount: number;
  downstreamPath: string;
  upstreamPath: string | null;
  clientContext: DownstreamClientContext | null;
  usage: ProxyUsageSummary;
  downstreamApiKeyId: number | null;
}) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    const normalizedErrorMessage = composeProxyLogMessage({
      clientKind: input.clientContext?.clientKind && input.clientContext.clientKind !== 'generic'
        ? input.clientContext.clientKind
        : null,
      sessionId: input.clientContext?.sessionId || null,
      traceHint: input.clientContext?.traceHint || null,
      downstreamPath: input.downstreamPath,
      upstreamPath: input.upstreamPath,
      errorMessage: input.errorMessage,
    });

    insertProxyLogBestEffort({
      ...resolveProxyLogRouteContext(input.selected),
      channelId: input.selected.channel.id,
      accountId: input.selected.account.id,
      downstreamApiKeyId: input.downstreamApiKeyId,
      modelRequested: input.modelRequested,
      modelActual: input.modelActual,
      status: input.status,
      httpStatus: input.httpStatus,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      totalTokens: input.usage.totalTokens,
      estimatedCost: 0,
      clientFamily: input.clientContext?.clientKind || null,
      clientAppId: input.clientContext?.clientAppId || null,
      clientAppName: input.clientContext?.clientAppName || null,
      clientConfidence: input.clientContext?.clientConfidence || null,
      errorMessage: normalizedErrorMessage,
      retryCount: input.retryCount,
      createdAt,
    });
  } catch (error) {
    console.warn('[proxy/responses.websocket] failed to write proxy log', error);
  }
}

async function forwardResponsesRequestViaHttp(input: {
  app: FastifyInstance;
  socket: WebSocket;
  request: IncomingMessage;
  payload: Record<string, unknown>;
  preserveIncrementalMode: boolean;
  authToken: string;
}): Promise<unknown[] | null> {
  const injectHeaders: Record<string, string | string[]> = {
    ...buildInjectHeaders(input.request),
    [RESPONSES_WEBSOCKET_TRANSPORT_HEADER]: '1',
    ...(input.preserveIncrementalMode ? { [RESPONSES_WEBSOCKET_MODE_HEADER]: 'incremental' } : {}),
  };
  if (
    !headerValueToTrimmedString(injectHeaders.authorization)
    && !headerValueToTrimmedString(injectHeaders['x-api-key'])
    && !headerValueToTrimmedString(injectHeaders['x-goog-api-key'])
  ) {
    injectHeaders.authorization = `Bearer ${input.authToken}`;
  }

  const response = await input.app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: injectHeaders,
    payload: input.payload,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(response.body);
    } catch {
      payload = null;
    }
    writeResponsesWebsocketError(
      input.socket,
      response.statusCode,
      response.statusMessage || 'Upstream error',
      payload,
    );
    return null;
  }

  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    try {
      const payload = JSON.parse(response.body);
      input.socket.send(JSON.stringify(payload));
      return isRecord(payload?.response) && Array.isArray(payload.response.output)
        ? cloneJsonObject(payload.response.output)
        : [];
    } catch {
      writeResponsesWebsocketError(input.socket, 502, 'Unexpected non-JSON websocket proxy response');
      return null;
    }
  }

  const pulled = openAiResponsesTransformer.pullSseEvents(response.body);
  const forwardedPayloads: unknown[] = [];
  let sawTerminalPayload = false;
  let sawMeaningfulOutput = false;
  for (const event of pulled.events) {
    if (event.data === '[DONE]') continue;
    try {
      const payload = JSON.parse(event.data);
      forwardedPayloads.push(payload);
      if (!sawMeaningfulOutput) {
        const responsePayload = isRecord(payload) && isRecord(payload.response) ? payload.response : payload;
        sawMeaningfulOutput = hasMeaningfulResponsesPayloadOutput(responsePayload);
      }
      const type = isRecord(payload) ? asTrimmedString(payload.type) : '';
      if (type === 'response.completed' || type === 'response.failed') {
        sawTerminalPayload = true;
      }
      input.socket.send(JSON.stringify(payload));
    } catch {
      // Ignore malformed SSE frames; the HTTP route already normalizes them.
    }
  }
  if (!sawTerminalPayload) {
    if (sawMeaningfulOutput) {
      return collectResponsesOutput(forwardedPayloads);
    }
    writeResponsesWebsocketError(input.socket, 408, 'stream closed before response.completed');
  }
  return collectResponsesOutput(forwardedPayloads);
}

function buildInjectHeaders(request: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [rawKey, rawValue] of Object.entries(request.headers)) {
    const key = rawKey.toLowerCase();
    if (!rawValue) continue;
    if (
      key === 'host'
      || key === 'connection'
      || key === 'upgrade'
      || key === 'sec-websocket-key'
      || key === 'sec-websocket-version'
      || key === 'sec-websocket-extensions'
      || key === 'sec-websocket-protocol'
    ) {
      continue;
    }
    headers[rawKey] = rawValue as string | string[];
  }
  return headers;
}

function extractWebsocketAuthToken(request: IncomingMessage, url: URL): string {
  const auth = headerValueToTrimmedString(request.headers.authorization);
  if (auth) return auth.replace(/^Bearer\s+/i, '').trim();
  const apiKey = headerValueToTrimmedString(request.headers['x-api-key']);
  if (apiKey) return apiKey;
  const googApiKey = headerValueToTrimmedString(request.headers['x-goog-api-key']);
  if (googApiKey) return googApiKey;
  return asTrimmedString(url.searchParams.get('key'));
}

function writeUpgradeHttpError(socket: Duplex, status: number, message: string): void {
  const statusText = status === 401
    ? 'Unauthorized'
    : status === 403
      ? 'Forbidden'
      : status === 400
        ? 'Bad Request'
        : 'Error';
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n`
    + 'Content-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + 'Connection: close\r\n'
    + '\r\n'
    + body,
  );
}

async function supportsResponsesWebsocketIncrementalInput(
  parsed: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null,
  authContext: ResponsesWebsocketAuthContext,
  routingPolicy: DownstreamRoutingPolicy,
): Promise<boolean> {
  const requestModel = asTrimmedString(parsed.model) || asTrimmedString(lastRequest?.model);
  if (!requestModel) return false;

  try {
    const selected = await tokenRouter.previewSelectedChannel(requestModel, routingPolicy);
    return selectedChannelSupportsIncrementalInput(selected, requestModel);
  } catch {
    return false;
  }
}

async function handleResponsesWebsocketConnection(
  app: FastifyInstance,
  socket: WebSocket,
  request: IncomingMessage,
  authContext: ResponsesWebsocketAuthContext,
) {
  const websocketSessionId = headerValueToTrimmedString(request.headers['session_id'])
    || headerValueToTrimmedString(request.headers['session-id'])
    || randomUUID();
  const stickySessionKey = `${authContext.source === 'managed' ? `mk:${authContext.key?.id ?? authContext.token}` : 'global:responses-ws'}:/v1/responses:${websocketSessionId}`;
  const routingPolicy: DownstreamRoutingPolicy = {
    ...authContext.policy,
    stickySessionKey,
  };
  let lastRequest: Record<string, unknown> | null = null;
  let lastResponseOutput: unknown[] = [];
  let selectedChannel: SelectedChannel | null = null;
  let messageQueue = Promise.resolve();

  socket.once('close', () => {
    void codexWebsocketRuntime.closeSession(websocketSessionId);
  });

  socket.on('message', (raw) => {
    messageQueue = messageQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          const parsed = parseJsonObject(raw);
          if (!parsed) {
            writeResponsesWebsocketError(socket, 400, 'Invalid websocket JSON payload');
            return;
          }

          const requestModel = asTrimmedString(parsed.model) || asTrimmedString(lastRequest?.model);
          if (requestModel && !await isModelAllowedByPolicyOrAllowedRoutes(requestModel, routingPolicy)) {
            writeResponsesWebsocketError(socket, 403, 'model is not allowed for this downstream key');
            return;
          }
          const supportsIncrementalInput = selectedChannelSupportsIncrementalInput(selectedChannel, requestModel)
            || await supportsResponsesWebsocketIncrementalInput(parsed, lastRequest, authContext, routingPolicy);
          const shouldHandleLocalPrewarm = shouldHandleResponsesWebsocketPrewarmLocally(
            parsed,
            lastRequest,
            supportsIncrementalInput,
          );
          const normalized = normalizeResponsesWebsocketRequest(
            parsed,
            lastRequest,
            lastResponseOutput,
            supportsIncrementalInput,
          );
          if (!normalized.ok) {
            writeResponsesWebsocketError(socket, normalized.status, normalized.message);
            return;
          }
          const downstreamPath = '/v1/responses';
          const clientContext = detectDownstreamClientContext({
            downstreamPath,
            headers: request.headers as Record<string, unknown>,
            body: normalized.request,
          });

          if (authContext.source === 'managed' && authContext.key?.id) {
            await consumeManagedKeyRequest(authContext.key.id);
          }

          lastRequest = normalized.nextRequestSnapshot;
          if (shouldHandleLocalPrewarm) {
            lastResponseOutput = [];
            for (const payload of synthesizePrewarmResponsePayloads(normalized.request)) {
              socket.send(JSON.stringify(payload));
            }
            return;
          }

          if (!shouldReuseSelectedChannel(selectedChannel, requestModel)) {
            selectedChannel = requestModel
              ? await tokenRouter.selectChannel(requestModel, routingPolicy)
              : null;
          }

          const codexWebsocketChannel = selectedChannelSupportsCodexWebsocketTransport(selectedChannel, requestModel)
            ? selectedChannel
            : null;

          if (codexWebsocketChannel) {
            const actualModel = asTrimmedString(codexWebsocketChannel.actualModel) || requestModel;
            const requestStartedAt = Date.now();
            const downstreamHeaders: Record<string, unknown> = {
              ...(request.headers as Record<string, unknown>),
              [RESPONSES_WEBSOCKET_TRANSPORT_HEADER]: '1',
              ...(supportsIncrementalInput ? { [RESPONSES_WEBSOCKET_MODE_HEADER]: 'incremental' } : {}),
            };
            const providerHeaders = buildOauthProviderHeaders({
              extraConfig: typeof codexWebsocketChannel.account.extraConfig === 'string'
                ? codexWebsocketChannel.account.extraConfig
                : null,
              downstreamHeaders,
            });
            const prepared = buildUpstreamEndpointRequest({
              endpoint: 'responses',
              modelName: actualModel,
              stream: true,
              tokenValue: codexWebsocketChannel.tokenValue,
              sitePlatform: codexWebsocketChannel.site.platform,
              siteUrl: codexWebsocketChannel.site.url,
              openaiBody: normalized.request,
              downstreamFormat: 'responses',
              responsesOriginalBody: normalized.request,
              downstreamHeaders,
              providerHeaders,
              codexExplicitSessionId: deriveCodexExplicitSessionId(normalized.request, websocketSessionId),
            });
            const requestUrl = `${codexWebsocketChannel.site.url.replace(/\/+$/, '')}${prepared.path}`;

            try {
              const runtimeResult = await codexWebsocketRuntime.sendRequest({
                sessionId: websocketSessionId,
                requestUrl,
                headers: prepared.headers,
                body: prepared.body,
              });
              await tokenRouter.recordSuccess?.(
                codexWebsocketChannel.channel.id,
                Date.now() - requestStartedAt,
                0,
                actualModel,
              );
              const runtimeUsage = collectResponsesUsageFromEvents(runtimeResult.events);
              await writeResponsesWebsocketProxyLog({
                selected: codexWebsocketChannel,
                modelRequested: requestModel || actualModel,
                modelActual: actualModel,
                status: 'success',
                httpStatus: 200,
                latencyMs: Date.now() - requestStartedAt,
                errorMessage: null,
                retryCount: 0,
                downstreamPath,
                upstreamPath: prepared.path,
                clientContext,
                usage: runtimeUsage,
                downstreamApiKeyId: authContext.key?.id ?? null,
              });
              lastResponseOutput = collectResponsesOutput(runtimeResult.events);
              for (const payload of runtimeResult.events) {
                socket.send(JSON.stringify(payload));
              }
            } catch (error) {
              const runtimeError = error instanceof CodexWebsocketRuntimeError
                ? error
                : new CodexWebsocketRuntimeError('upstream websocket request failed');
              const runtimeHasMeaningfulOutput = hasMeaningfulResponsesEventsOutput(runtimeError.events);
              if (runtimeHasMeaningfulOutput) {
                const runtimeUsage = collectResponsesUsageFromEvents(runtimeError.events);
                await tokenRouter.recordSuccess?.(
                  codexWebsocketChannel.channel.id,
                  Date.now() - requestStartedAt,
                  0,
                  actualModel,
                );
                await writeResponsesWebsocketProxyLog({
                  selected: codexWebsocketChannel,
                  modelRequested: requestModel || actualModel,
                  modelActual: actualModel,
                  status: 'success',
                  httpStatus: 200,
                  latencyMs: Date.now() - requestStartedAt,
                  errorMessage: null,
                  retryCount: 0,
                  downstreamPath,
                  upstreamPath: prepared.path,
                  clientContext,
                  usage: runtimeUsage,
                  downstreamApiKeyId: authContext.key?.id ?? null,
                });
                lastResponseOutput = collectResponsesOutput(runtimeError.events);
                for (const payload of runtimeError.events) {
                  socket.send(JSON.stringify(payload));
                }
                return;
              }
              await tokenRouter.recordFailure?.(codexWebsocketChannel.channel.id, {
                status: runtimeError.status ?? 0,
                errorText: runtimeError.message,
                modelName: actualModel,
              });
              selectedChannel = null;
              if (runtimeError.status && runtimeError.events.length === 0) {
                const fallbackOutput = await forwardResponsesRequestViaHttp({
                  app,
                  socket,
                  request,
                  payload: normalized.request,
                  preserveIncrementalMode: false,
                  authToken: authContext.token,
                });
                if (fallbackOutput) {
                  lastResponseOutput = fallbackOutput;
                }
                return;
              }
              const runtimeUsage = collectResponsesUsageFromEvents(runtimeError.events);
              await writeResponsesWebsocketProxyLog({
                selected: codexWebsocketChannel,
                modelRequested: requestModel || actualModel,
                modelActual: actualModel,
                status: 'failed',
                httpStatus: runtimeError.status || 502,
                latencyMs: Date.now() - requestStartedAt,
                errorMessage: runtimeError.message,
                retryCount: 0,
                downstreamPath,
                upstreamPath: prepared.path,
                clientContext,
                usage: runtimeUsage,
                downstreamApiKeyId: authContext.key?.id ?? null,
              });
              lastResponseOutput = collectResponsesOutput(runtimeError.events);
              for (const payload of runtimeError.events) {
                socket.send(JSON.stringify(payload));
              }
              writeResponsesWebsocketError(
                socket,
                runtimeError.status || 408,
                runtimeError.message,
                runtimeError.payload,
              );
            }
            return;
          }

          const forwardedOutput = await forwardResponsesRequestViaHttp({
            app,
            socket,
            request,
            payload: normalized.request,
            preserveIncrementalMode: supportsIncrementalInput,
            authToken: authContext.token,
          });
          if (forwardedOutput) {
            lastResponseOutput = forwardedOutput;
          }
        } catch {
          writeResponsesWebsocketError(socket, 500, 'internal websocket proxy error');
        }
      });
  });
}

export function ensureResponsesWebsocketTransport(app: FastifyInstance) {
  if (installedApps.has(app)) return;
  installedApps.add(app);

  const websocketServer = new WebSocketServer({ noServer: true });
  websocketServer.on('headers', (headers, request) => {
    const turnState = headerValueToTrimmedString(request.headers[WS_TURN_STATE_HEADER]);
    if (!turnState) return;
    headers.push(`${WS_TURN_STATE_HEADER}: ${turnState}`);
  });

  app.server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname !== '/v1/responses') return;
      const token = extractWebsocketAuthToken(request, url);
      if (!token) {
        writeUpgradeHttpError(socket, 401, 'Missing Authorization, x-api-key, x-goog-api-key, or key query parameter');
        return;
      }
      const authResult = await authorizeDownstreamToken(token);
      if (!authResult.ok) {
        writeUpgradeHttpError(socket, authResult.statusCode, authResult.error);
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        void handleResponsesWebsocketConnection(app, client, request, authResult);
      });
    })().catch(() => {
      writeUpgradeHttpError(socket, 500, 'internal websocket proxy error');
    });
  });

  app.addHook('onClose', async () => {
    await codexWebsocketRuntime.closeAllSessions();
    await new Promise<void>((resolve) => {
      websocketServer.close(() => resolve());
    });
  });
}
