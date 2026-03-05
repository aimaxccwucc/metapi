import { fetchModelPricingCatalog } from '../../services/modelPricingService.js';
import type { DownstreamFormat } from './chatFormats.js';

export type UpstreamEndpoint = 'chat' | 'messages' | 'responses';
export type EndpointPreference = DownstreamFormat | 'responses';

type ChannelContext = {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatformName(platform: unknown): string {
  return asTrimmedString(platform).toLowerCase();
}

function isClaudeFamilyModel(modelName: string): boolean {
  const normalized = asTrimmedString(modelName).toLowerCase();
  if (!normalized) return false;
  return normalized === 'claude' || normalized.startsWith('claude-') || normalized.includes('claude');
}

function headerValueToString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const BLOCKED_PASSTHROUGH_HEADERS = new Set([
  'host',
  'content-type',
  'content-length',
  'accept-encoding',
  'cookie',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
]);

function shouldSkipPassthroughHeader(key: string): boolean {
  return HOP_BY_HOP_HEADERS.has(key) || BLOCKED_PASSTHROUGH_HEADERS.has(key);
}

function extractSafePassthroughHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) return {};

  const forwarded: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (!key || shouldSkipPassthroughHeader(key)) continue;

    const value = headerValueToString(rawValue);
    if (!value) continue;
    forwarded[key] = value;
  }

  return forwarded;
}

function extractClaudePassthroughHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) return {};

  const forwarded: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const shouldForward = (
      key.startsWith('anthropic-')
      || key.startsWith('x-claude-')
      || key.startsWith('x-stainless-')
    );
    if (!shouldForward) continue;

    const value = headerValueToString(rawValue);
    if (!value) continue;
    forwarded[key] = value;
  }

  return forwarded;
}

function extractResponsesPassthroughHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) return {};

  const forwarded: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const shouldForward = (
      key.startsWith('openai-')
      || key.startsWith('x-openai-')
      || key.startsWith('x-stainless-')
      || key.startsWith('chatgpt-')
      || key === 'originator'
    );
    if (!shouldForward) continue;

    const value = headerValueToString(rawValue);
    if (!value) continue;
    forwarded[key] = value;
  }

  return forwarded;
}

function ensureStreamAcceptHeader(
  headers: Record<string, string>,
  stream: boolean,
): Record<string, string> {
  if (!stream) return headers;

  const existingAccept = (
    headerValueToString(headers.accept)
    || headerValueToString((headers as Record<string, unknown>).Accept)
  );
  if (existingAccept) return headers;

  return {
    ...headers,
    accept: 'text/event-stream',
  };
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeMessagesBodyForAnthropic(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...body };
  const hasTemperature = toFiniteNumber(sanitized.temperature) !== null;
  const hasTopP = toFiniteNumber(sanitized.top_p) !== null;
  // Some Anthropic-compatible upstreams reject requests carrying both fields.
  if (hasTemperature && hasTopP) {
    delete sanitized.top_p;
  }

  // Claude Code may send thinking.type = "adaptive". Many Anthropic-compatible
  // upstreams only accept enabled/disabled.
  const thinking = sanitized.thinking;
  if (isRecord(thinking)) {
    const rawType = asTrimmedString(thinking.type).toLowerCase();
    if (rawType === 'adaptive') {
      const budgetTokens = toFiniteNumber(thinking.budget_tokens);
      if (budgetTokens !== null && budgetTokens > 0) {
        sanitized.thinking = {
          ...thinking,
          type: 'enabled',
          budget_tokens: Math.trunc(budgetTokens),
        };
      } else {
        sanitized.thinking = { type: 'disabled' };
      }
    } else if (rawType && rawType !== 'enabled' && rawType !== 'disabled') {
      sanitized.thinking = { type: 'disabled' };
    }
  }

  return sanitized;
}

function normalizeContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!isRecord(item)) return '';
        const text = asTrimmedString(item.text ?? item.content ?? item.output_text);
        return text;
      })
      .filter((item) => item.length > 0)
      .join('\n');
  }
  if (isRecord(content)) {
    const text = asTrimmedString(content.text ?? content.content ?? content.output_text);
    return text;
  }
  return '';
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function parseJsonString(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { value: raw };
  }
}

function normalizeOpenAiToolArguments(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw) || isRecord(raw)) {
    return safeJsonStringify(raw);
  }
  return '';
}

function normalizeAnthropicToolInput(raw: unknown): unknown {
  if (raw === undefined || raw === null) return {};
  if (isRecord(raw) || Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return parseJsonString(raw);
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  return {};
}

function normalizeToolMessageContent(raw: unknown): string {
  const contentText = normalizeContentText(raw).trim();
  if (contentText) return contentText;

  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw) || isRecord(raw)) return safeJsonStringify(raw);
  return '';
}

function convertOpenAiToolsToAnthropic(rawTools: unknown): unknown {
  if (!Array.isArray(rawTools)) return rawTools;

  const converted = rawTools
    .map((item) => {
      if (!isRecord(item)) return null;

      const type = asTrimmedString(item.type).toLowerCase();
      if (type === 'function' && isRecord(item.function)) {
        const fn = item.function;
        const name = asTrimmedString(fn.name);
        if (!name) return null;

        const mapped: Record<string, unknown> = { name };
        const description = asTrimmedString(fn.description);
        if (description) mapped.description = description;
        if (fn.parameters !== undefined) mapped.input_schema = fn.parameters;
        if (item.cache_control !== undefined) mapped.cache_control = item.cache_control;
        return mapped;
      }

      if (asTrimmedString(item.name) && item.input_schema !== undefined) {
        return item;
      }

      return null;
    })
    .filter((item): item is Record<string, unknown> => !!item);

  return converted.length > 0 ? converted : rawTools;
}

function convertOpenAiToolChoiceToAnthropic(rawToolChoice: unknown): unknown {
  if (rawToolChoice === undefined) return undefined;

  if (typeof rawToolChoice === 'string') {
    const normalized = rawToolChoice.trim().toLowerCase();
    if (normalized === 'required') return { type: 'any' };
    if (normalized === 'none') return { type: 'none' };
    if (normalized === 'auto') return { type: 'auto' };
    if (normalized === 'any') return { type: 'any' };
    return rawToolChoice;
  }

  if (!isRecord(rawToolChoice)) return rawToolChoice;

  const type = asTrimmedString(rawToolChoice.type).toLowerCase();
  if (type === 'function' && isRecord(rawToolChoice.function)) {
    const name = asTrimmedString(rawToolChoice.function.name);
    return name ? { type: 'tool', name } : { type: 'any' };
  }

  if (type === 'tool' || type === 'auto' || type === 'any' || type === 'none') {
    return rawToolChoice;
  }

  return rawToolChoice;
}

function convertOpenAiToolsToResponses(rawTools: unknown): unknown {
  if (!Array.isArray(rawTools)) return rawTools;

  const converted = rawTools
    .map((item) => {
      if (!isRecord(item)) return null;

      const type = asTrimmedString(item.type).toLowerCase();
      if (type === 'function' && isRecord(item.function)) {
        const fn = item.function;
        const name = asTrimmedString(fn.name);
        if (!name) return null;

        const mapped: Record<string, unknown> = {
          type: 'function',
          name,
        };
        const description = asTrimmedString(fn.description);
        if (description) mapped.description = description;
        if (fn.parameters !== undefined) mapped.parameters = fn.parameters;
        if (fn.strict !== undefined) mapped.strict = fn.strict;
        return mapped;
      }

      if (type === 'function' && asTrimmedString(item.name)) {
        return item;
      }

      if (type === 'image_generation') {
        return item;
      }

      return null;
    })
    .filter((item): item is Record<string, unknown> => !!item);

  return converted.length > 0 ? converted : rawTools;
}

function convertOpenAiToolChoiceToResponses(rawToolChoice: unknown): unknown {
  if (rawToolChoice === undefined) return undefined;
  if (typeof rawToolChoice === 'string') return rawToolChoice;
  if (!isRecord(rawToolChoice)) return rawToolChoice;

  const type = asTrimmedString(rawToolChoice.type).toLowerCase();
  if (type === 'function' && isRecord(rawToolChoice.function)) {
    const name = asTrimmedString(rawToolChoice.function.name);
    if (!name) return 'required';
    return { type: 'function', name };
  }

  return rawToolChoice;
}

function toResponsesInputMessageFromText(text: string): Record<string, unknown> {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

function normalizeResponsesMessageItem(item: Record<string, unknown>): Record<string, unknown> {
  const type = asTrimmedString(item.type).toLowerCase();
  if (type === 'function_call' || type === 'function_call_output') {
    return item;
  }

  const role = asTrimmedString(item.role).toLowerCase();
  const textContent = normalizeContentText(item.content ?? item.text).trim();

  if (type === 'message') {
    if (!textContent) return item;
    const normalizedRole = role || 'user';
    const textType = normalizedRole === 'assistant' ? 'output_text' : 'input_text';
    return {
      ...item,
      role: normalizedRole,
      content: [{ type: textType, text: textContent }],
    };
  }

  if (role) {
    if (!textContent) return item;
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    return {
      type: 'message',
      role,
      content: [{ type: textType, text: textContent }],
    };
  }

  if (textContent) {
    return toResponsesInputMessageFromText(textContent);
  }

  return item;
}

function normalizeResponsesInputForCompatibility(input: unknown): unknown {
  if (typeof input === 'string') {
    const normalized = input.trim();
    if (!normalized) return input;
    return [toResponsesInputMessageFromText(normalized)];
  }

  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === 'string') {
        const normalized = item.trim();
        return normalized ? toResponsesInputMessageFromText(normalized) : item;
      }
      if (!isRecord(item)) return item;
      return normalizeResponsesMessageItem(item);
    });
  }

  if (isRecord(input)) {
    return [normalizeResponsesMessageItem(input)];
  }

  return input;
}

function normalizeResponsesBodyForCompatibility(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const nextInput = normalizeResponsesInputForCompatibility(body.input);
  if (nextInput === body.input) return body;
  return {
    ...body,
    input: nextInput,
  };
}

const ALLOWED_RESPONSES_FIELDS = new Set([
  'model',
  'input',
  'instructions',
  'max_output_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'truncation',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'metadata',
  'reasoning',
  'store',
  'stream',
  'user',
  'previous_response_id',
  'text',
  'audio',
  'include',
  'response_format',
  'service_tier',
  'stop',
  'n',
]);

function sanitizeResponsesBodyForProxy(
  body: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  let normalized = normalizeResponsesBodyForCompatibility({
    ...body,
    model: modelName,
    stream,
  });

  if (normalized.input === undefined) {
    if (Array.isArray((normalized as Record<string, unknown>).messages)) {
      const converted = convertOpenAiBodyToResponsesBody(normalized, modelName, stream);
      normalized = normalizeResponsesBodyForCompatibility(converted);
    } else {
      const prompt = asTrimmedString((normalized as Record<string, unknown>).prompt);
      if (prompt) {
        normalized = {
          ...normalized,
          input: [toResponsesInputMessageFromText(prompt)],
        };
      }
    }
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (!ALLOWED_RESPONSES_FIELDS.has(key)) continue;
    if (key === 'max_completion_tokens') continue;
    sanitized[key] = value;
  }

  const maxOutputTokens = toFiniteNumber(normalized.max_output_tokens);
  if (maxOutputTokens !== null && maxOutputTokens > 0) {
    sanitized.max_output_tokens = Math.trunc(maxOutputTokens);
  } else {
    const maxCompletionTokens = toFiniteNumber(normalized.max_completion_tokens);
    if (maxCompletionTokens !== null && maxCompletionTokens > 0) {
      sanitized.max_output_tokens = Math.trunc(maxCompletionTokens);
    }
  }

  sanitized.model = modelName;
  sanitized.stream = stream;
  return sanitized;
}

function convertOpenAiBodyToMessagesBody(
  openaiBody: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  const rawMessages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
  const systemContents: string[] = [];
  const messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  }> = [];

  const appendAssistantMessage = (item: Record<string, unknown>) => {
    const role = asTrimmedString(item.role).toLowerCase() || 'assistant';
    if (role !== 'assistant') return;

    const contentBlocks: Array<Record<string, unknown>> = [];

    const textContent = normalizeContentText(item.content).trim();
    if (textContent) {
      contentBlocks.push({
        type: 'text',
        text: textContent,
      });
    }

    const rawToolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
    for (let index = 0; index < rawToolCalls.length; index += 1) {
      const toolCall = rawToolCalls[index];
      if (!isRecord(toolCall)) continue;
      const functionPart = isRecord(toolCall.function) ? toolCall.function : {};

      const id = asTrimmedString(toolCall.id) || `toolu_${Date.now()}_${index}`;
      const name = (
        asTrimmedString(functionPart.name)
        || asTrimmedString(toolCall.name)
        || `tool_${index}`
      );
      const input = normalizeAnthropicToolInput(functionPart.arguments ?? toolCall.arguments);

      contentBlocks.push({
        type: 'tool_use',
        id,
        name,
        input,
      });
    }

    if (contentBlocks.length <= 0) return;

    if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') {
      const singleText = asTrimmedString(contentBlocks[0].text);
      if (singleText) {
        messages.push({
          role: 'assistant',
          content: singleText,
        });
      }
      return;
    }

    messages.push({
      role: 'assistant',
      content: contentBlocks,
    });
  };

  for (let messageIndex = 0; messageIndex < rawMessages.length; messageIndex += 1) {
    const item = rawMessages[messageIndex];
    if (!isRecord(item)) continue;
    const role = asTrimmedString(item.role).toLowerCase() || 'user';

    if (role === 'system' || role === 'developer') {
      const content = normalizeContentText(item.content);
      if (!content) continue;
      systemContents.push(content);
      continue;
    }

    if (role === 'tool') {
      const toolResultBlocks: Array<Record<string, unknown>> = [];
      let cursor = messageIndex;
      while (cursor < rawMessages.length) {
        const toolCandidate = rawMessages[cursor];
        if (!isRecord(toolCandidate)) break;
        const toolRole = asTrimmedString(toolCandidate.role).toLowerCase();
        if (toolRole !== 'tool') break;

        const toolUseId = (
          asTrimmedString(toolCandidate.tool_call_id)
          || asTrimmedString(toolCandidate.id)
        );
        const toolResultContent = normalizeToolMessageContent(toolCandidate.content).trim();
        if (toolUseId && toolResultContent) {
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: toolResultContent,
          });
        }
        cursor += 1;
      }

      if (toolResultBlocks.length > 0 && cursor < rawMessages.length) {
        const nextItem = rawMessages[cursor];
        if (isRecord(nextItem)) {
          const nextRole = asTrimmedString(nextItem.role).toLowerCase();
          if (nextRole === 'user') {
            const userText = normalizeContentText(nextItem.content).trim();
            if (userText) {
              toolResultBlocks.push({
                type: 'text',
                text: userText,
              });
            }
            cursor += 1;
          }
        }
      }

      if (toolResultBlocks.length > 0) {
        messages.push({
          role: 'user',
          content: toolResultBlocks,
        });
      }

      messageIndex = cursor - 1;
      continue;
    }

    if (role === 'assistant') {
      appendAssistantMessage(item);
      continue;
    }

    const content = normalizeContentText(item.content).trim();
    if (!content) continue;

    messages.push({
      role: 'user',
      content,
    });
  }

  const body: Record<string, unknown> = {
    model: modelName,
    stream,
    messages,
    max_tokens: toFiniteNumber(openaiBody.max_tokens) ?? 4096,
  };

  if (systemContents.length > 0) {
    body.system = systemContents.join('\n\n');
  }

  const temperature = toFiniteNumber(openaiBody.temperature);
  if (temperature !== null) body.temperature = temperature;

  const topP = toFiniteNumber(openaiBody.top_p);
  if (topP !== null) body.top_p = topP;

  if (Array.isArray(openaiBody.stop) && openaiBody.stop.length > 0) {
    body.stop_sequences = openaiBody.stop;
  }

  if (openaiBody.tools !== undefined) body.tools = convertOpenAiToolsToAnthropic(openaiBody.tools);

  const anthropicToolChoice = convertOpenAiToolChoiceToAnthropic(openaiBody.tool_choice);
  if (anthropicToolChoice !== undefined) body.tool_choice = anthropicToolChoice;

  return body;
}

function convertOpenAiBodyToResponsesBody(
  openaiBody: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  const rawMessages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
  const systemContents: string[] = [];
  const inputItems: Array<Record<string, unknown>> = [];

  for (const item of rawMessages) {
    if (!isRecord(item)) continue;
    const role = asTrimmedString(item.role).toLowerCase() || 'user';

    if (role === 'system' || role === 'developer') {
      const content = normalizeContentText(item.content).trim();
      if (!content) continue;
      systemContents.push(content);
      continue;
    }

    if (role === 'assistant') {
      const textContent = normalizeContentText(item.content).trim();
      if (textContent) {
        inputItems.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: textContent }],
        });
      }

      const rawToolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      for (let index = 0; index < rawToolCalls.length; index += 1) {
        const toolCall = rawToolCalls[index];
        if (!isRecord(toolCall)) continue;
        const functionPart = isRecord(toolCall.function) ? toolCall.function : {};
        const callId = asTrimmedString(toolCall.id) || `call_${Date.now()}_${index}`;
        const name = (
          asTrimmedString(functionPart.name)
          || asTrimmedString(toolCall.name)
          || `tool_${index}`
        );
        const argumentsValue = normalizeOpenAiToolArguments(
          functionPart.arguments ?? toolCall.arguments,
        );

        inputItems.push({
          type: 'function_call',
          call_id: callId,
          name,
          arguments: argumentsValue,
        });
      }
      continue;
    }

    if (role === 'tool') {
      const callId = asTrimmedString(item.tool_call_id) || asTrimmedString(item.id);
      if (!callId) continue;

      inputItems.push({
        type: 'function_call_output',
        call_id: callId,
        output: normalizeToolMessageContent(item.content),
      });
      continue;
    }

    const content = normalizeContentText(item.content).trim();
    if (!content) continue;
    inputItems.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }],
    });
  }

  const maxOutputTokens = (
    toFiniteNumber(openaiBody.max_output_tokens)
    ?? toFiniteNumber(openaiBody.max_completion_tokens)
    ?? toFiniteNumber(openaiBody.max_tokens)
    ?? 4096
  );

  const body: Record<string, unknown> = {
    model: modelName,
    stream,
    max_output_tokens: maxOutputTokens,
    input: inputItems,
  };

  if (systemContents.length > 0) {
    body.instructions = systemContents.join('\n\n');
  }

  const temperature = toFiniteNumber(openaiBody.temperature);
  if (temperature !== null) body.temperature = temperature;

  const topP = toFiniteNumber(openaiBody.top_p);
  if (topP !== null) body.top_p = topP;

  if (openaiBody.metadata !== undefined) body.metadata = openaiBody.metadata;
  if (openaiBody.reasoning !== undefined) body.reasoning = openaiBody.reasoning;
  if (openaiBody.parallel_tool_calls !== undefined) body.parallel_tool_calls = openaiBody.parallel_tool_calls;

  if (openaiBody.tools !== undefined) body.tools = convertOpenAiToolsToResponses(openaiBody.tools);

  const responsesToolChoice = convertOpenAiToolChoiceToResponses(openaiBody.tool_choice);
  if (responsesToolChoice !== undefined) body.tool_choice = responsesToolChoice;

  return normalizeResponsesBodyForCompatibility(body);
}

function normalizeEndpointTypes(value: unknown): UpstreamEndpoint[] {
  const raw = asTrimmedString(value).toLowerCase();
  if (!raw) return [];

  const normalized = new Set<UpstreamEndpoint>();

  if (
    raw.includes('/v1/messages')
    || raw === 'messages'
    || raw.includes('anthropic')
    || raw.includes('claude')
  ) {
    normalized.add('messages');
  }

  if (
    raw.includes('/v1/responses')
    || raw === 'responses'
    || raw.includes('response')
  ) {
    normalized.add('responses');
  }

  if (
    raw.includes('/v1/chat/completions')
    || raw.includes('chat/completions')
    || raw === 'chat'
    || raw === 'chat_completions'
    || raw === 'completions'
    || raw.includes('chat')
  ) {
    normalized.add('chat');
  }

  // Some upstreams return protocol families instead of concrete endpoint paths.
  if (raw === 'openai' || raw.includes('openai')) {
    normalized.add('chat');
    normalized.add('responses');
  }

  return Array.from(normalized);
}

function preferredEndpointOrder(
  downstreamFormat: EndpointPreference,
  sitePlatform?: string,
  preferMessagesForClaudeModel = false,
): UpstreamEndpoint[] {
  const platform = normalizePlatformName(sitePlatform);

  if (platform === 'gemini') {
    // Gemini upstream is routed through OpenAI-compatible chat endpoint.
    return ['chat'];
  }

  if (platform === 'openai') {
    if (preferMessagesForClaudeModel && downstreamFormat !== 'responses') {
      // Some OpenAI-compatible gateways expose Claude natively via /v1/messages.
      // Keep chat/responses as fallbacks when messages is unavailable.
      return ['messages', 'chat', 'responses'];
    }
    return downstreamFormat === 'responses'
      ? ['responses', 'chat', 'messages']
      : ['chat', 'responses', 'messages'];
  }

  if (platform === 'claude') {
    return ['messages'];
  }

  // Unknown/generic upstreams: prefer endpoint family that matches the
  // downstream API surface, then degrade progressively.
  if (downstreamFormat === 'responses') {
    if (preferMessagesForClaudeModel) {
      // Claude-family models on generic/new-api upstreams are commonly
      // messages-first even when downstream API is /v1/responses.
      return ['messages', 'chat', 'responses'];
    }
    return ['responses', 'chat', 'messages'];
  }

  if (downstreamFormat === 'claude') {
    return ['messages', 'chat', 'responses'];
  }

  if (downstreamFormat === 'openai' && preferMessagesForClaudeModel) {
    // Claude-family models are most stable with native Messages semantics.
    return ['messages', 'chat', 'responses'];
  }

  return ['chat', 'messages', 'responses'];
}

export async function resolveUpstreamEndpointCandidates(
  context: ChannelContext,
  modelName: string,
  downstreamFormat: EndpointPreference,
  requestedModelHint?: string,
): Promise<UpstreamEndpoint[]> {
  const sitePlatform = normalizePlatformName(context.site.platform);
  const preferMessagesForClaudeModel = (
    isClaudeFamilyModel(modelName)
    || isClaudeFamilyModel(asTrimmedString(requestedModelHint))
  );
  if (sitePlatform === 'anyrouter') {
    // anyrouter deployments are effectively anthropic-protocol first.
    if (downstreamFormat === 'responses') {
      return ['responses', 'messages', 'chat'];
    }
    return ['messages', 'chat', 'responses'];
  }

  const preferred = preferredEndpointOrder(
    downstreamFormat,
    context.site.platform,
    preferMessagesForClaudeModel,
  );
  const forceMessagesFirstForClaudeModel = (
    downstreamFormat === 'openai'
    && preferMessagesForClaudeModel
    && sitePlatform !== 'openai'
    && sitePlatform !== 'gemini'
  );

  try {
    const catalog = await fetchModelPricingCatalog({
      site: {
        id: context.site.id,
        url: context.site.url,
        platform: context.site.platform,
        apiKey: context.site.apiKey ?? null,
      },
      account: {
        id: context.account.id,
        accessToken: context.account.accessToken ?? null,
        apiToken: context.account.apiToken ?? null,
      },
      modelName,
      totalTokens: 0,
    });

    if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      return preferred;
    }

    const matched = catalog.models.find((item) =>
      asTrimmedString(item?.modelName).toLowerCase() === modelName.toLowerCase(),
    );
    if (!matched) return preferred;

    const shouldIgnoreCatalogOrderingForClaudeMessages = (
      preferMessagesForClaudeModel
      && (downstreamFormat !== 'responses' || sitePlatform !== 'openai')
    );
    if (shouldIgnoreCatalogOrderingForClaudeMessages) {
      return preferred;
    }

    const supportedRaw = Array.isArray(matched.supportedEndpointTypes) ? matched.supportedEndpointTypes : [];
    const normalizedSupportedRaw = supportedRaw
      .map((item) => asTrimmedString(item).toLowerCase())
      .filter((item) => item.length > 0);
    const hasConcreteEndpointHint = normalizedSupportedRaw.some((raw) => (
      raw.includes('/v1/messages')
      || raw.includes('/v1/chat/completions')
      || raw.includes('/v1/responses')
      || raw === 'messages'
      || raw === 'chat'
      || raw === 'chat_completions'
      || raw === 'completions'
      || raw === 'responses'
    ));
    if (forceMessagesFirstForClaudeModel && !hasConcreteEndpointHint) {
      // Generic labels like openai/anthropic are too coarse for Claude models;
      // keep messages-first order in this case.
      return preferred;
    }

    const supported = new Set<UpstreamEndpoint>();
    for (const endpoint of supportedRaw) {
      const normalizedList = normalizeEndpointTypes(endpoint);
      for (const normalized of normalizedList) {
        supported.add(normalized);
      }
    }

    if (supported.size === 0) return preferred;

    const firstSupported = preferred.find((endpoint) => supported.has(endpoint));
    if (!firstSupported) return preferred;

    // Catalog metadata can be incomplete/inaccurate, so only use it to pick
    // the first attempt. Keep downstream-driven fallback order unchanged.
    return [
      firstSupported,
      ...preferred.filter((endpoint) => endpoint !== firstSupported),
    ];
  } catch {
    return preferred;
  }
}

export function buildUpstreamEndpointRequest(input: {
  endpoint: UpstreamEndpoint;
  modelName: string;
  stream: boolean;
  tokenValue: string;
  sitePlatform?: string;
  siteUrl?: string;
  openaiBody: Record<string, unknown>;
  downstreamFormat: EndpointPreference;
  claudeOriginalBody?: Record<string, unknown>;
  responsesOriginalBody?: Record<string, unknown>;
  downstreamHeaders?: Record<string, unknown>;
}): {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const sitePlatform = normalizePlatformName(input.sitePlatform);
  const isClaudeUpstream = sitePlatform === 'claude';

  const resolveGeminiEndpointPath = (endpoint: UpstreamEndpoint): string => {
    const normalizedSiteUrl = asTrimmedString(input.siteUrl).toLowerCase();
    const openAiCompatBase = /\/openai(?:\/|$)/.test(normalizedSiteUrl);
    if (openAiCompatBase) {
      return endpoint === 'responses'
        ? '/responses'
        : '/chat/completions';
    }
    return endpoint === 'responses'
      ? '/v1beta/openai/responses'
      : '/v1beta/openai/chat/completions';
  };

  const resolveEndpointPath = (endpoint: UpstreamEndpoint): string => {
    if (sitePlatform === 'gemini') {
      return resolveGeminiEndpointPath(endpoint);
    }

    if (sitePlatform === 'openai') {
      if (endpoint === 'messages') return '/v1/messages';
      if (endpoint === 'responses') return '/v1/responses';
      return '/v1/chat/completions';
    }

    if (sitePlatform === 'claude') {
      return '/v1/messages';
    }

    if (endpoint === 'messages') return '/v1/messages';
    if (endpoint === 'responses') return '/v1/responses';
    return '/v1/chat/completions';
  };

  const passthroughHeaders = extractSafePassthroughHeaders(input.downstreamHeaders);
  const commonHeaders: Record<string, string> = {
    ...passthroughHeaders,
    'Content-Type': 'application/json',
  };
  if (!isClaudeUpstream) {
    commonHeaders.Authorization = `Bearer ${input.tokenValue}`;
  }

  if (input.endpoint === 'messages') {
    const claudeHeaders = input.downstreamFormat === 'claude'
      ? extractClaudePassthroughHeaders(input.downstreamHeaders)
      : {};
    const anthropicVersion = (
      claudeHeaders['anthropic-version']
      || passthroughHeaders['anthropic-version']
      || '2023-06-01'
    );
    const body = (
      input.downstreamFormat === 'claude' && input.claudeOriginalBody
        ? {
          ...input.claudeOriginalBody,
          model: input.modelName,
          stream: input.stream,
        }
        : convertOpenAiBodyToMessagesBody(input.openaiBody, input.modelName, input.stream)
    );
    const sanitizedBody = sanitizeMessagesBodyForAnthropic(body);

    const headers = ensureStreamAcceptHeader({
      ...commonHeaders,
      ...claudeHeaders,
      'x-api-key': input.tokenValue,
      'anthropic-version': anthropicVersion,
    }, input.stream);

    return {
      path: resolveEndpointPath('messages'),
      headers,
      body: sanitizedBody,
    };
  }

  if (input.endpoint === 'responses') {
    const responsesHeaders = input.downstreamFormat === 'responses'
      ? extractResponsesPassthroughHeaders(input.downstreamHeaders)
      : {};
    const rawBody = (
      input.downstreamFormat === 'responses' && input.responsesOriginalBody
        ? {
          ...input.responsesOriginalBody,
          model: input.modelName,
          stream: input.stream,
        }
        : convertOpenAiBodyToResponsesBody(input.openaiBody, input.modelName, input.stream)
    );
    const body = sanitizeResponsesBodyForProxy(rawBody, input.modelName, input.stream);

    const headers = ensureStreamAcceptHeader({
      ...commonHeaders,
      ...responsesHeaders,
    }, input.stream);

    return {
      path: resolveEndpointPath('responses'),
      headers,
      body,
    };
  }

  const headers = ensureStreamAcceptHeader(commonHeaders, input.stream);
  return {
    path: resolveEndpointPath('chat'),
    headers,
    body: {
      ...input.openaiBody,
      model: input.modelName,
      stream: input.stream,
    },
  };
}

function normalizeHeaderMap(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const value = headerValueToString(rawValue);
    if (!value) continue;
    normalized[key] = value;
  }
  return normalized;
}

export function buildMinimalJsonHeadersForCompatibility(input: {
  headers: Record<string, string>;
  endpoint: UpstreamEndpoint;
  stream: boolean;
}): Record<string, string> {
  const source = normalizeHeaderMap(input.headers);
  const minimal: Record<string, string> = {};

  if (source.authorization) minimal.authorization = source.authorization;
  if (source['x-api-key']) minimal['x-api-key'] = source['x-api-key'];

  if (input.endpoint === 'messages') {
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith('anthropic-')) continue;
      minimal[key] = value;
    }
    if (!minimal['anthropic-version']) {
      minimal['anthropic-version'] = '2023-06-01';
    }
  }

  minimal['content-type'] = 'application/json';
  minimal.accept = input.stream ? 'text/event-stream' : 'application/json';
  return minimal;
}

export function isUnsupportedMediaTypeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  if (status !== 400 && status !== 415) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return status === 415;

  return (
    text.includes('unsupported media type')
    || text.includes("only 'application/json' is allowed")
    || text.includes('only "application/json" is allowed')
    || text.includes('application/json')
    || text.includes('content-type')
  );
}

export function isEndpointDowngradeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (status === 404 || status === 405 || status === 415 || status === 501) return true;
  if (!text) return false;

  let parsedCode = '';
  let parsedType = '';
  let parsedMessage = '';
  try {
    const parsed = JSON.parse(upstreamErrorText || '{}') as Record<string, unknown>;
    const error = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : parsed;
    parsedCode = asTrimmedString(error.code).toLowerCase();
    parsedType = asTrimmedString(error.type).toLowerCase();
    parsedMessage = asTrimmedString(error.message).toLowerCase();
  } catch {
    parsedCode = '';
    parsedType = '';
    parsedMessage = '';
  }

  return (
    text.includes('convert_request_failed')
    || text.includes('not found')
    || text.includes('unknown endpoint')
    || text.includes('unsupported endpoint')
    || text.includes('unsupported path')
    || text.includes('unrecognized request url')
    || text.includes('no route matched')
    || text.includes('does not exist')
    || text.includes('openai_error')
    || text.includes('upstream_error')
    || text.includes('bad_response_status_code')
    || text.includes('unsupported media type')
    || text.includes("only 'application/json' is allowed")
    || text.includes('only "application/json" is allowed')
    || (status === 400 && text.includes('unsupported'))
    || text.includes('not implemented')
    || text.includes('api not implemented')
    || text.includes('unsupported legacy protocol')
    || parsedCode === 'convert_request_failed'
    || parsedCode === 'not_found'
    || parsedCode === 'endpoint_not_found'
    || parsedCode === 'unknown_endpoint'
    || parsedCode === 'unsupported_endpoint'
    || parsedCode === 'bad_response_status_code'
    || parsedCode === 'openai_error'
    || parsedCode === 'upstream_error'
    || parsedType === 'not_found_error'
    || parsedType === 'invalid_request_error'
    || parsedType === 'unsupported_endpoint'
    || parsedType === 'unsupported_path'
    || parsedType === 'bad_response_status_code'
    || parsedType === 'openai_error'
    || parsedType === 'upstream_error'
    || parsedMessage.includes('unknown endpoint')
    || parsedMessage.includes('unsupported endpoint')
    || parsedMessage.includes('unsupported path')
    || parsedMessage.includes('unrecognized request url')
    || parsedMessage.includes('no route matched')
    || parsedMessage.includes('does not exist')
    || parsedMessage.includes('bad_response_status_code')
    || parsedMessage === 'openai_error'
    || parsedMessage === 'upstream_error'
    || parsedMessage.includes('unsupported media type')
    || parsedMessage.includes("only 'application/json' is allowed")
    || parsedMessage.includes('only "application/json" is allowed')
    || (
      status === 400
      && parsedCode === 'invalid_request'
      && parsedType === 'new_api_error'
      && (parsedMessage.includes('claude code cli') || text.includes('claude code cli'))
    )
  );
}
