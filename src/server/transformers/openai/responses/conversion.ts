import {
  normalizeResponsesInputForCompatibility as normalizeResponsesInputForCompatibilityViaCompatibility,
  normalizeResponsesMessageItem,
} from './compatibility.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function cloneRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return { ...value };
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    ) as T;
  }
  return value;
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

export function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextContent(item))
      .filter((item) => item.length > 0)
      .join('\n');
  }
  if (!isRecord(value)) return '';

  const direct = asTrimmedString(
    value.text
    ?? value.content
    ?? value.input_text
    ?? value.output_text
    ?? value.reasoning
    ?? value.reasoning_content
    ?? value.thinking,
  );
  if (direct) return direct;

  if (Array.isArray(value.parts)) return extractTextContent(value.parts);
  if (Array.isArray(value.content)) return extractTextContent(value.content);
  if (Array.isArray(value.output)) return extractTextContent(value.output);
  return '';
}

function normalizeOpenAiToolArguments(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw) || isRecord(raw)) return safeJsonStringify(raw);
  return '';
}

function normalizeToolOutput(raw: unknown): string {
  const text = extractTextContent(raw).trim();
  if (text) return text;
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw) || isRecord(raw)) return safeJsonStringify(raw);
  return '';
}

export function normalizeResponsesInputForCompatibility(input: unknown): unknown {
  return normalizeResponsesInputForCompatibilityViaCompatibility(input);
}

function toResponsesInputMessageFromText(text: string): Record<string, unknown> {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
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

      if (type === 'custom' && asTrimmedString(item.name)) {
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

export function normalizeResponsesMessageContent(role: string, content: unknown): Array<Record<string, unknown>> {
  const normalized = normalizeResponsesMessageItem({
    type: 'message',
    role,
    content,
  });

  if (isRecord(normalized) && Array.isArray(normalized.content)) {
    return normalized.content.filter((item): item is Record<string, unknown> => isRecord(item));
  }

  return [];
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
  'safety_identifier',
  'stream',
  'stream_options',
  'user',
  'max_tool_calls',
  'prompt_cache_key',
  'prompt_cache_retention',
  'background',
  'previous_response_id',
  'text',
  'audio',
  'include',
  'response_format',
  'service_tier',
  'stop',
  'n',
]);

export function sanitizeResponsesBodyForProxy(
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
      normalized = normalizeResponsesBodyForCompatibility(
        convertOpenAiBodyToResponsesBody(normalized, modelName, stream),
      );
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

export function convertOpenAiBodyToResponsesBody(
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
      const content = extractTextContent(item.content).trim();
      if (content) systemContents.push(content);
      continue;
    }

    if (role === 'assistant') {
      const normalizedContent = normalizeResponsesMessageContent('assistant', item.content);
      if (normalizedContent.length > 0) {
        inputItems.push({
          type: 'message',
          role: 'assistant',
          content: normalizedContent,
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
        output: normalizeToolOutput(item.content),
      });
      continue;
    }

    const normalizedContent = normalizeResponsesMessageContent('user', item.content);
    if (normalizedContent.length <= 0) continue;
    inputItems.push({
      type: 'message',
      role: 'user',
      content: normalizedContent,
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
  if (openaiBody.safety_identifier !== undefined) body.safety_identifier = openaiBody.safety_identifier;
  if (openaiBody.max_tool_calls !== undefined) body.max_tool_calls = openaiBody.max_tool_calls;
  if (openaiBody.prompt_cache_key !== undefined) body.prompt_cache_key = openaiBody.prompt_cache_key;
  if (openaiBody.prompt_cache_retention !== undefined) {
    body.prompt_cache_retention = openaiBody.prompt_cache_retention;
  }
  if (openaiBody.background !== undefined) body.background = openaiBody.background;
  if (openaiBody.user !== undefined) body.user = openaiBody.user;
  if (openaiBody.include !== undefined) body.include = cloneJsonValue(openaiBody.include);
  if (openaiBody.previous_response_id !== undefined) body.previous_response_id = openaiBody.previous_response_id;
  if (openaiBody.truncation !== undefined) body.truncation = openaiBody.truncation;
  if (openaiBody.service_tier !== undefined) body.service_tier = openaiBody.service_tier;
  if (openaiBody.top_logprobs !== undefined) body.top_logprobs = openaiBody.top_logprobs;
  if (openaiBody.stream_options !== undefined) body.stream_options = openaiBody.stream_options;

  const textConfig = cloneRecord(openaiBody.text) || {};
  const verbosity = (
    asTrimmedString(openaiBody.verbosity)
    || asTrimmedString(isRecord(openaiBody.text) ? openaiBody.text.verbosity : undefined)
  );
  if (verbosity) {
    textConfig.verbosity = verbosity;
  }
  if (Object.keys(textConfig).length > 0) {
    body.text = textConfig;
  }

  const responsesToolChoice = convertOpenAiToolChoiceToResponses(openaiBody.tool_choice);
  if (responsesToolChoice !== undefined) body.tool_choice = responsesToolChoice;

  return normalizeResponsesBodyForCompatibility(body);
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
      arguments: normalizeOpenAiToolArguments(item.arguments ?? item.input),
    },
  };
}

function normalizeOpenAiContentBlock(item: Record<string, unknown>): string | Record<string, unknown> | null {
  const type = asTrimmedString(item.type).toLowerCase();
  if (!type) {
    const text = extractTextContent(item).trim();
    return text ? { type: 'text', text } : null;
  }

  if (
    type === 'input_text'
    || type === 'output_text'
    || type === 'text'
    || type === 'summary_text'
    || type === 'reasoning_text'
  ) {
    const text = extractTextContent(item).trim();
    return text ? { type: 'text', text } : null;
  }

  if (type === 'input_image') {
    const imageUrl = item.image_url ?? item.url;
    if (imageUrl === undefined) return null;
    return {
      type: 'image_url',
      image_url: imageUrl,
    };
  }

  if (type === 'input_audio' && item.input_audio !== undefined) {
    return {
      type: 'input_audio',
      input_audio: item.input_audio,
    };
  }

  if (type === 'reasoning' || type === 'thinking' || type === 'redacted_reasoning') {
    const text = extractTextContent(item).trim();
    return text ? { type: 'text', text } : null;
  }

  return item;
}

function toOpenAiMessageContent(content: unknown): string | Array<string | Record<string, unknown>> {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (isRecord(content)) {
      const single = normalizeOpenAiContentBlock(content);
      if (!single) return '';
      return typeof single === 'string' ? single : [single];
    }
    return '';
  }

  const blocks = content
    .map((item) => {
      if (typeof item === 'string') return item.trim() ? item : null;
      if (!isRecord(item)) return null;
      return normalizeOpenAiContentBlock(item);
    })
    .filter((item): item is string | Record<string, unknown> => !!item);

  if (blocks.length === 1 && typeof blocks[0] === 'string') {
    return blocks[0];
  }
  return blocks;
}

function convertResponsesToolsToOpenAi(rawTools: unknown): unknown {
  if (!Array.isArray(rawTools)) return rawTools;

  return rawTools.map((item) => {
    if (!isRecord(item)) return item;
    const type = asTrimmedString(item.type).toLowerCase();

    if (type === 'custom' || type === 'image_generation') return item;
    if (type !== 'function') return item;
    if (isRecord(item.function) && asTrimmedString(item.function.name)) return item;

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

export function convertResponsesBodyToOpenAiBody(
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
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: normalizeToolOutput(outputRaw),
    });
  };

  const processInputItem = (item: unknown) => {
    if (typeof item === 'string') {
      flushPendingToolCalls();
      const text = item.trim();
      if (text) messages.push({ role: 'user', content: text });
      return;
    }

    if (!isRecord(item)) return;

    const itemType = asTrimmedString(item.type).toLowerCase();
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const toolCall = toOpenAiToolCall(item, functionCallIndex);
      functionCallIndex += 1;
      if (toolCall) pendingToolCalls.push(toolCall);
      return;
    }

    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      flushPendingToolCalls();
      pushToolOutputMessage(item.call_id ?? item.id, item.output ?? item.content);
      return;
    }

    if (itemType === 'reasoning') {
      flushPendingToolCalls();
      const reasoningContent = toOpenAiMessageContent(item.summary ?? item.content ?? item);
      const hasReasoningContent = typeof reasoningContent === 'string'
        ? reasoningContent.trim().length > 0
        : Array.isArray(reasoningContent) && reasoningContent.length > 0;
      if (!hasReasoningContent) return;

      messages.push({
        role: 'assistant',
        content: reasoningContent,
      });
      return;
    }

    flushPendingToolCalls();
    const role = asTrimmedString(item.role).toLowerCase() || 'user';
    const normalizedRole = role === 'developer' ? 'system' : role;
    const content = toOpenAiMessageContent(item.content ?? item.input ?? item);

    if (normalizedRole === 'tool') {
      pushToolOutputMessage(item.tool_call_id ?? item.call_id ?? item.id, item.content);
      return;
    }

    const hasContent = typeof content === 'string'
      ? content.trim().length > 0
      : Array.isArray(content) && content.length > 0;
    if (!hasContent) return;

    messages.push({
      role: normalizedRole,
      content,
    });
  };

  if (typeof input === 'string') {
    const text = input.trim();
    if (text) messages.push({ role: 'user', content: text });
  } else if (Array.isArray(input)) {
    for (const item of input) processInputItem(item);
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
  if (body.safety_identifier !== undefined) payload.safety_identifier = body.safety_identifier;
  if (body.max_tool_calls !== undefined) payload.max_tool_calls = body.max_tool_calls;
  if (body.prompt_cache_key !== undefined) payload.prompt_cache_key = body.prompt_cache_key;
  if (body.prompt_cache_retention !== undefined) payload.prompt_cache_retention = body.prompt_cache_retention;
  if (body.background !== undefined) payload.background = body.background;
  if (body.user !== undefined) payload.user = body.user;
  if (body.include !== undefined) payload.include = cloneJsonValue(body.include);
  if (body.previous_response_id !== undefined) payload.previous_response_id = body.previous_response_id;
  if (body.truncation !== undefined) payload.truncation = body.truncation;
  if (body.service_tier !== undefined) payload.service_tier = body.service_tier;
  if (body.top_logprobs !== undefined) payload.top_logprobs = body.top_logprobs;
  if (body.stream_options !== undefined) payload.stream_options = body.stream_options;
  if (isRecord(body.text) && asTrimmedString(body.text.verbosity)) {
    payload.verbosity = asTrimmedString(body.text.verbosity);
  }

  return payload;
}
