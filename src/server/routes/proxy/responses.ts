import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { db, schema } from '../../db/index.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { estimateProxyCost } from '../../services/modelPricingService.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { withExplicitProxyRequestInit } from '../../services/siteProxy.js';
import {
  createStreamTransformContext,
  normalizeUpstreamFinalResponse,
  normalizeUpstreamStreamEvent,
  pullSseEventsWithDone,
  type NormalizedStreamEvent,
} from './chatFormats.js';
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

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function normalizeToolArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) || isRecord(value)) return stringifyJson(value);
  return '';
}

function normalizeToolOutput(value: unknown): string {
  const text = normalizeText(value).trim();
  if (text) return text;
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) || isRecord(value)) return stringifyJson(value);
  return '';
}

type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

function toOpenAiToolCall(item: Record<string, unknown>, fallbackIndex: number): OpenAiToolCall | null {
  const callId = (
    asTrimmedString(item.call_id)
    || asTrimmedString(item.id)
    || `call_${Date.now()}_${fallbackIndex}`
  );
  const name = asTrimmedString(item.name);
  if (!name) return null;

  return {
    id: callId,
    type: 'function',
    function: {
      name,
      arguments: normalizeToolArguments(item.arguments),
    },
  };
}

function extractTextAndToolsFromResponsesMessage(
  rawContent: unknown,
  fallbackPrefix: string,
): {
  text: string;
  toolCalls: OpenAiToolCall[];
  toolResults: Array<{ id: string; content: string }>;
} {
  const contentItems = Array.isArray(rawContent) ? rawContent : [rawContent];
  const textParts: string[] = [];
  const toolCalls: OpenAiToolCall[] = [];
  const toolResults: Array<{ id: string; content: string }> = [];

  for (let index = 0; index < contentItems.length; index += 1) {
    const part = contentItems[index];
    if (!isRecord(part)) {
      const text = normalizeText(part).trim();
      if (text) textParts.push(text);
      continue;
    }

    const partType = asTrimmedString(part.type).toLowerCase();
    if (partType === 'tool_use') {
      const callId = asTrimmedString(part.id) || `call_${fallbackPrefix}_${index}`;
      const name = asTrimmedString(part.name);
      if (!name) continue;

      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name,
          arguments: normalizeToolArguments(part.input),
        },
      });
      continue;
    }

    if (partType === 'tool_result') {
      const id = asTrimmedString(part.tool_use_id) || asTrimmedString(part.id);
      if (!id) continue;
      toolResults.push({
        id,
        content: normalizeToolOutput(part.content),
      });
      continue;
    }

    const text = normalizeText(part).trim();
    if (text) textParts.push(text);
  }

  return {
    text: textParts.join('\n').trim(),
    toolCalls,
    toolResults,
  };
}

function convertResponsesToolsToOpenAi(rawTools: unknown): unknown {
  if (!Array.isArray(rawTools)) return rawTools;

  const converted = rawTools
    .map((item) => {
      if (!isRecord(item)) return item;
      const type = asTrimmedString(item.type).toLowerCase();

      if (type !== 'function') return item;

      if (isRecord(item.function) && asTrimmedString(item.function.name)) {
        return item;
      }

      const name = asTrimmedString(item.name);
      if (!name) return item;

      const fn: Record<string, unknown> = { name };
      const description = asTrimmedString(item.description);
      if (description) fn.description = description;
      if (item.parameters !== undefined) fn.parameters = item.parameters;
      if (item.strict !== undefined) fn.strict = item.strict;

      return {
        type: 'function',
        function: fn,
      };
    });

  return converted;
}

function convertResponsesToolChoiceToOpenAi(rawToolChoice: unknown): unknown {
  if (rawToolChoice === undefined) return undefined;
  if (typeof rawToolChoice === 'string') return rawToolChoice;
  if (!isRecord(rawToolChoice)) return rawToolChoice;

  const type = asTrimmedString(rawToolChoice.type).toLowerCase();
  if (type === 'function') {
    if (isRecord(rawToolChoice.function) && asTrimmedString(rawToolChoice.function.name)) {
      return rawToolChoice;
    }

    const name = asTrimmedString(rawToolChoice.name);
    if (!name) return 'required';
    return {
      type: 'function',
      function: { name },
    };
  }

  if (type === 'auto' || type === 'none' || type === 'required') {
    return type;
  }

  return rawToolChoice;
}

function convertResponsesBodyToOpenAiBody(
  body: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const input = body.input;
  let functionCallIndex = 0;
  let pendingToolCalls: OpenAiToolCall[] = [];

  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length <= 0) return;
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  };

  const pushToolOutputMessage = (callIdRaw: unknown, outputRaw: unknown) => {
    const toolCallId = asTrimmedString(callIdRaw);
    if (!toolCallId) return;
    const content = normalizeToolOutput(outputRaw);
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content,
    });
  };

  const pushUserMessage = (content: string) => {
    if (!content) return;
    messages.push({ role: 'user', content });
  };

  const processInputItem = (item: unknown) => {
    if (typeof item === 'string') {
      flushPendingToolCalls();
      const text = item.trim();
      if (text) pushUserMessage(text);
      return;
    }

    if (!isRecord(item)) return;

    const itemType = asTrimmedString(item.type).toLowerCase();
    if (itemType === 'function_call') {
      const toolCall = toOpenAiToolCall(item, functionCallIndex);
      functionCallIndex += 1;
      if (!toolCall) return;
      pendingToolCalls.push(toolCall);
      return;
    }

    if (itemType === 'function_call_output') {
      flushPendingToolCalls();
      pushToolOutputMessage(item.call_id ?? item.id, item.output ?? item.content);
      return;
    }

    flushPendingToolCalls();

    const role = asTrimmedString(item.role).toLowerCase() || 'user';
    const messageContent = item.content ?? item.input ?? item;
    const parsed = extractTextAndToolsFromResponsesMessage(
      messageContent,
      `${Date.now()}_${messages.length}`,
    );

    if (role === 'assistant') {
      if (!parsed.text && parsed.toolCalls.length <= 0) return;

      const assistantMessage: Record<string, unknown> = {
        role: 'assistant',
        content: parsed.text,
      };
      if (parsed.toolCalls.length > 0) {
        assistantMessage.tool_calls = parsed.toolCalls;
      }
      messages.push(assistantMessage);
      return;
    }

    const normalizedRole = role === 'system' || role === 'developer'
      ? 'system'
      : role === 'tool'
        ? 'tool'
        : 'user';

    if (normalizedRole === 'tool') {
      pushToolOutputMessage(item.tool_call_id ?? item.call_id ?? item.id, messageContent);
      return;
    }

    if (parsed.text) {
      messages.push({
        role: normalizedRole,
        content: parsed.text,
      });
    }

    for (const toolResult of parsed.toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: toolResult.id,
        content: toolResult.content,
      });
    }
  };

  if (typeof input === 'string') {
    const text = input.trim();
    if (text) {
      messages.push({ role: 'user', content: text });
    }
  } else if (Array.isArray(input)) {
    for (const item of input) {
      processInputItem(item);
    }
  } else if (isRecord(input)) {
    processInputItem(input);
  }
  flushPendingToolCalls();

  const instructions = asTrimmedString(body.instructions);
  if (instructions) {
    messages.unshift({ role: 'system', content: instructions });
  }

  const payload: Record<string, unknown> = {
    model: modelName,
    stream,
    messages,
  };

  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    payload.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) {
    payload.top_p = body.top_p;
  }
  if (typeof body.max_output_tokens === 'number' && Number.isFinite(body.max_output_tokens)) {
    payload.max_tokens = body.max_output_tokens;
  }
  if (body.parallel_tool_calls !== undefined) payload.parallel_tool_calls = body.parallel_tool_calls;
  if (body.tools !== undefined) payload.tools = convertResponsesToolsToOpenAi(body.tools);
  if (body.tool_choice !== undefined) payload.tool_choice = convertResponsesToolChoiceToOpenAi(body.tool_choice);

  return payload;
}

type UsageSummary = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type ResponsesToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type ResponsesMessageItemState = {
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  text: string;
};

type ResponsesToolItemState = {
  toolIndex: number;
  itemId: string;
  callId: string;
  outputIndex: number;
  name: string;
  arguments: string;
};

type ResponsesStreamState = {
  started: boolean;
  completed: boolean;
  responseId: string;
  model: string;
  createdAt: number;
  sequenceNumber: number;
  outputCursor: number;
  messageItem: ResponsesMessageItemState | null;
  toolItems: Map<number, ResponsesToolItemState>;
};

function ensureResponseId(rawId: string): string {
  const trimmed = rawId.trim() || `resp_${Date.now()}`;
  return trimmed.startsWith('resp_') ? trimmed : `resp_${trimmed}`;
}

function ensureMessageId(rawId: string): string {
  const trimmed = rawId.trim() || `msg_${Date.now()}`;
  return trimmed.startsWith('msg_') ? trimmed : `msg_${trimmed}`;
}

function ensureFunctionCallId(rawId: string): string {
  const trimmed = rawId.trim();
  if (!trimmed) return `call_${Date.now()}`;
  return trimmed.startsWith('call_') ? trimmed : `call_${trimmed}`;
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function extractToolCallsFromUpstream(payload: unknown): ResponsesToolCall[] {
  if (!isRecord(payload)) return [];

  if (Array.isArray(payload.choices)) {
    const choice = payload.choices[0];
    const message = isRecord((choice as any)?.message) ? (choice as any).message : {};
    const toolCalls = Array.isArray((message as any).tool_calls) ? (message as any).tool_calls : [];
    return toolCalls
      .map((item: unknown, index: number) => {
        if (!isRecord(item)) return null;
        const fn = isRecord(item.function) ? item.function : {};
        const id = typeof item.id === 'string' && item.id.trim().length > 0
          ? item.id
          : `call_${index}`;
        const name = typeof fn.name === 'string' ? fn.name : '';
        const args = typeof fn.arguments === 'string' ? fn.arguments : '';
        return {
          id: ensureFunctionCallId(id),
          name,
          arguments: args,
        };
      })
      .filter((item: ResponsesToolCall | null): item is ResponsesToolCall => !!item);
  }

  if (payload.type === 'message' && Array.isArray(payload.content)) {
    return payload.content
      .map((item: unknown, index: number) => {
        if (!isRecord(item) || item.type !== 'tool_use') return null;
        const id = typeof item.id === 'string' && item.id.trim().length > 0
          ? item.id
          : `call_${index}`;
        const name = typeof item.name === 'string' ? item.name : '';
        const args = stringifyToolInput(item.input);
        return {
          id: ensureFunctionCallId(id),
          name,
          arguments: args,
        };
      })
      .filter((item: ResponsesToolCall | null): item is ResponsesToolCall => !!item);
  }

  return [];
}

function toResponsesPayload(
  upstreamPayload: unknown,
  normalized: ReturnType<typeof normalizeUpstreamFinalResponse>,
  usage: UsageSummary,
): Record<string, unknown> {
  if (isRecord(upstreamPayload) && upstreamPayload.object === 'response') {
    return upstreamPayload;
  }

  const normalizedId = typeof normalized.id === 'string' && normalized.id.trim()
    ? normalized.id.trim()
    : `resp_${Date.now()}`;
  const responseId = ensureResponseId(normalizedId);
  const messageId = ensureMessageId(normalizedId);
  const toolCalls = extractToolCallsFromUpstream(upstreamPayload);

  const output: Array<Record<string, unknown>> = [];
  if (normalized.content || toolCalls.length === 0) {
    output.push({
      id: messageId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text: normalized.content || '',
      }],
    });
  }

  for (const toolCall of toolCalls) {
    output.push({
      id: toolCall.id,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    });
  }

  return {
    id: responseId,
    object: 'response',
    created: normalized.created,
    status: 'completed',
    model: normalized.model,
    output,
    output_text: normalized.content || '',
    usage: {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    },
  };
}

function createResponsesStreamState(modelName: string): ResponsesStreamState {
  return {
    started: false,
    completed: false,
    responseId: `resp_meta_${Date.now()}`,
    model: modelName,
    createdAt: Math.floor(Date.now() / 1000),
    sequenceNumber: 0,
    outputCursor: 0,
    messageItem: null,
    toolItems: new Map(),
  };
}

function toResponsesUsage(usage: UsageSummary): Record<string, number> {
  return {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}

function nextSequence(state: ResponsesStreamState): number {
  const value = state.sequenceNumber;
  state.sequenceNumber += 1;
  return value;
}

function serializeResponsesSse(eventType: string, payload: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function emitResponsesEvent(
  state: ResponsesStreamState,
  eventType: string,
  payload: Record<string, unknown>,
): string {
  return serializeResponsesSse(eventType, {
    type: eventType,
    sequence_number: nextSequence(state),
    ...payload,
  });
}

function buildResponseObject(
  state: ResponsesStreamState,
  status: 'in_progress' | 'completed' | 'failed',
  usage?: UsageSummary,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: state.responseId,
    object: 'response',
    created_at: state.createdAt,
    status,
    model: state.model,
    output: [],
  };
  if (usage) {
    response.usage = toResponsesUsage(usage);
  }
  return response;
}

function ensureResponsesStarted(
  state: ResponsesStreamState,
  streamContext: { id: string; model: string; created: number },
): string[] {
  if (state.started) return [];

  state.started = true;
  state.responseId = ensureResponseId(streamContext.id || state.responseId);
  state.model = streamContext.model || state.model;
  state.createdAt = streamContext.created || state.createdAt;

  const inProgress = buildResponseObject(state, 'in_progress');
  return [
    emitResponsesEvent(state, 'response.created', { response: inProgress }),
    emitResponsesEvent(state, 'response.in_progress', { response: inProgress }),
  ];
}

function ensureMessageItem(state: ResponsesStreamState): string[] {
  if (state.messageItem) return [];

  const outputIndex = state.outputCursor;
  state.outputCursor += 1;
  const itemId = ensureMessageId(`${state.responseId}_${outputIndex}`);
  state.messageItem = {
    itemId,
    outputIndex,
    contentIndex: 0,
    text: '',
  };

  return [
    emitResponsesEvent(state, 'response.output_item.added', {
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    }),
    emitResponsesEvent(state, 'response.content_part.added', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: {
        type: 'output_text',
        text: '',
      },
    }),
  ];
}

function toIncrementalText(existingText: string, incomingText: string): string {
  if (!incomingText) return '';
  if (!existingText) return incomingText;

  if (incomingText === existingText) return '';
  if (incomingText.startsWith(existingText)) {
    return incomingText.slice(existingText.length);
  }
  if (existingText.endsWith(incomingText)) return '';

  // Some upstreams emit overlapping windows instead of strict deltas.
  // Keep only the non-overlapping suffix to avoid duplicated text.
  const maxOverlap = Math.min(existingText.length, incomingText.length);
  const MIN_OVERLAP = 8;
  for (let overlap = maxOverlap; overlap >= MIN_OVERLAP; overlap -= 1) {
    if (existingText.slice(-overlap) === incomingText.slice(0, overlap)) {
      return incomingText.slice(overlap);
    }
  }

  return incomingText;
}

function appendMessageDelta(state: ResponsesStreamState, delta: string): string[] {
  if (!delta) return [];

  const events: string[] = [];
  events.push(...ensureMessageItem(state));
  if (!state.messageItem) return events;

  const normalizedDelta = toIncrementalText(state.messageItem.text, delta);
  if (!normalizedDelta) return events;

  state.messageItem.text += normalizedDelta;
  events.push(emitResponsesEvent(state, 'response.output_text.delta', {
    item_id: state.messageItem.itemId,
    output_index: state.messageItem.outputIndex,
    content_index: state.messageItem.contentIndex,
    delta: normalizedDelta,
  }));
  return events;
}

function closeMessageItem(state: ResponsesStreamState): string[] {
  if (!state.messageItem) return [];

  const item = state.messageItem;
  const events = [
    emitResponsesEvent(state, 'response.output_text.done', {
      item_id: item.itemId,
      output_index: item.outputIndex,
      content_index: item.contentIndex,
      text: item.text,
    }),
    emitResponsesEvent(state, 'response.content_part.done', {
      item_id: item.itemId,
      output_index: item.outputIndex,
      content_index: item.contentIndex,
      part: {
        type: 'output_text',
        text: item.text,
      },
    }),
    emitResponsesEvent(state, 'response.output_item.done', {
      output_index: item.outputIndex,
      item: {
        id: item.itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: item.text,
        }],
      },
    }),
  ];

  state.messageItem = null;
  return events;
}

function ensureToolItem(
  state: ResponsesStreamState,
  toolIndex: number,
  id?: string,
  name?: string,
): string[] {
  const existing = state.toolItems.get(toolIndex);
  if (existing) {
    if (id && !existing.callId) existing.callId = ensureFunctionCallId(id);
    if (id && !existing.itemId) existing.itemId = ensureFunctionCallId(id);
    if (name && !existing.name) existing.name = name;
    return [];
  }

  const outputIndex = state.outputCursor;
  state.outputCursor += 1;
  const callId = ensureFunctionCallId(id || `${state.responseId}_${toolIndex}`);
  const itemId = callId;
  const toolState: ResponsesToolItemState = {
    toolIndex,
    itemId,
    callId,
    outputIndex,
    name: name || '',
    arguments: '',
  };
  state.toolItems.set(toolIndex, toolState);

  return [
    emitResponsesEvent(state, 'response.output_item.added', {
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'function_call',
        status: 'in_progress',
        call_id: callId,
        name: toolState.name,
        arguments: '',
      },
    }),
  ];
}

function appendToolCallDelta(
  state: ResponsesStreamState,
  toolDelta: NonNullable<NormalizedStreamEvent['toolCallDeltas']>[number],
): string[] {
  const toolIndex = Number.isFinite(toolDelta.index) ? Math.max(0, Math.trunc(toolDelta.index)) : 0;
  const events: string[] = [];
  events.push(...ensureToolItem(state, toolIndex, toolDelta.id, toolDelta.name));

  const toolState = state.toolItems.get(toolIndex);
  if (!toolState) return events;
  if (toolDelta.name && !toolState.name) toolState.name = toolDelta.name;

  if (toolDelta.argumentsDelta !== undefined) {
    toolState.arguments += toolDelta.argumentsDelta;
    events.push(emitResponsesEvent(state, 'response.function_call_arguments.delta', {
      item_id: toolState.itemId,
      output_index: toolState.outputIndex,
      delta: toolDelta.argumentsDelta,
    }));
  }

  return events;
}

function closeToolItems(state: ResponsesStreamState): string[] {
  if (state.toolItems.size <= 0) return [];

  const ordered = Array.from(state.toolItems.values())
    .sort((a, b) => a.outputIndex - b.outputIndex);
  const events: string[] = [];
  for (const toolItem of ordered) {
    events.push(emitResponsesEvent(state, 'response.function_call_arguments.done', {
      item_id: toolItem.itemId,
      output_index: toolItem.outputIndex,
      arguments: toolItem.arguments,
    }));
    events.push(emitResponsesEvent(state, 'response.output_item.done', {
      output_index: toolItem.outputIndex,
      item: {
        id: toolItem.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: toolItem.callId,
        name: toolItem.name,
        arguments: toolItem.arguments,
      },
    }));
  }

  state.toolItems.clear();
  return events;
}

function completeResponsesStream(
  state: ResponsesStreamState,
  streamContext: { id: string; model: string; created: number },
  usage: UsageSummary,
): string[] {
  if (state.completed) return [];

  const events: string[] = [];
  events.push(...ensureResponsesStarted(state, streamContext));
  events.push(...closeMessageItem(state));
  events.push(...closeToolItems(state));
  events.push(emitResponsesEvent(state, 'response.completed', {
    response: buildResponseObject(state, 'completed', usage),
  }));
  events.push('data: [DONE]\n\n');
  state.completed = true;
  return events;
}

function failResponsesStream(
  state: ResponsesStreamState,
  streamContext: { id: string; model: string; created: number },
  usage: UsageSummary,
  payload?: unknown,
): string[] {
  if (state.completed) return [];

  const events: string[] = [];
  events.push(...ensureResponsesStarted(state, streamContext));

  const responsePayload = isRecord(payload) && isRecord((payload as any).response)
    ? ((payload as any).response as Record<string, unknown>)
    : null;
  const errorPayload = isRecord(payload) && isRecord((payload as any).error)
    ? ((payload as any).error as Record<string, unknown>)
    : null;

  if (responsePayload && asTrimmedString(responsePayload.id)) {
    state.responseId = ensureResponseId(asTrimmedString(responsePayload.id));
  }
  if (responsePayload && asTrimmedString(responsePayload.model)) {
    state.model = asTrimmedString(responsePayload.model);
  }

  const failedResponse = buildResponseObject(state, 'failed', usage);
  if (errorPayload) {
    failedResponse.error = errorPayload;
  }

  events.push(emitResponsesEvent(state, 'response.failed', {
    response: failedResponse,
  }));
  events.push('data: [DONE]\n\n');
  state.completed = true;
  return events;
}

function serializeConvertedResponsesEvents(input: {
  state: ResponsesStreamState;
  streamContext: { id: string; model: string; created: number };
  event: NormalizedStreamEvent;
  usage: UsageSummary;
}): string[] {
  const { state, streamContext, event, usage } = input;
  if (state.completed) return [];

  const shouldStart = (
    event.role === 'assistant'
    || !!event.contentDelta
    || !!event.reasoningDelta
    || (Array.isArray(event.toolCallDeltas) && event.toolCallDeltas.length > 0)
    || !!event.done
    || !!event.finishReason
  );

  const events: string[] = [];
  if (shouldStart) {
    events.push(...ensureResponsesStarted(state, streamContext));
  }

  if (event.contentDelta) {
    events.push(...appendMessageDelta(state, event.contentDelta));
  }
  if (event.reasoningDelta) {
    events.push(...appendMessageDelta(state, event.reasoningDelta));
  }

  if (Array.isArray(event.toolCallDeltas) && event.toolCallDeltas.length > 0) {
    events.push(...closeMessageItem(state));
    for (const toolDelta of event.toolCallDeltas) {
      events.push(...appendToolCallDelta(state, toolDelta));
    }
  }

  if (event.finishReason) {
    // Keep compatibility with clients that expect finish before completed.
  }

  if (event.done) {
    events.push(...completeResponsesStream(state, streamContext, usage));
  }

  return events;
}

export async function responsesProxyRoute(app: FastifyInstance) {
  app.post('/v1/responses', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const requestedModel = typeof body?.model === 'string' ? body.model.trim() : '';
    const downstreamPath = '/v1/responses';
    if (!requestedModel) {
      return reply.code(400).send({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }
    if (!ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);

    const isStream = body.stream === true;
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
              openaiBody: openAiBody,
              downstreamFormat: 'responses',
              responsesOriginalBody: body,
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
                    withExplicitProxyRequestInit(selected.site.proxyUrl, {
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
              withExplicitProxyRequestInit(selected.site.proxyUrl, {
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
          let parsedUsage: UsageSummary = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          let sseBuffer = '';

          const passthroughResponsesStream = successfulUpstreamPath === '/v1/responses';
          const streamContext = createStreamTransformContext(modelName);
          const responsesState = createResponsesStreamState(modelName);

          const writeLines = (lines: string[]) => {
            for (const line of lines) reply.raw.write(line);
          };

          const consumeSseBuffer = (incoming: string): string => {
            const pulled = pullSseEventsWithDone(incoming);
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
                const normalizedEvent = normalizeUpstreamStreamEvent(parsedPayload, streamContext, modelName);
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
          let estimatedCost = await estimateProxyCost({
            site: selected.site,
            account: selected.account,
            modelName: selected.actualModel || requestedModel,
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
            selected, requestedModel, 'success', 200, latency, null, retryCount, downstreamPath,
            resolvedUsage.promptTokens, resolvedUsage.completionTokens, resolvedUsage.totalTokens, estimatedCost,
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
        const normalized = normalizeUpstreamFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = toResponsesPayload(upstreamData, normalized, parsedUsage);
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
        let estimatedCost = await estimateProxyCost({
          site: selected.site,
          account: selected.account,
          modelName: selected.actualModel || requestedModel,
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
          selected, requestedModel, 'success', 200, latency, null, retryCount, downstreamPath,
          resolvedUsage.promptTokens, resolvedUsage.completionTokens, resolvedUsage.totalTokens, estimatedCost,
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
  });
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
    console.warn('[proxy/responses] failed to write proxy log', error);
  }
}
