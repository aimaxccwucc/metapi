function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toTextBlockType(role: string): 'input_text' | 'output_text' {
  return role === 'assistant' ? 'output_text' : 'input_text';
}

function normalizeImageUrlValue(value: unknown): string | Record<string, unknown> | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (!isRecord(value)) return null;
  const url = asTrimmedString(value.url);
  if (url) return { ...value, url };
  const imageUrl = asTrimmedString(value.image_url);
  if (imageUrl) return imageUrl;
  return Object.keys(value).length > 0 ? value : null;
}

function normalizeAudioInputValue(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const data = asTrimmedString(value.data);
  const format = asTrimmedString(value.format);
  if (!data && !format) return Object.keys(value).length > 0 ? value : null;
  return {
    ...value,
    ...(data ? { data } : {}),
    ...(format ? { format } : {}),
  };
}

function normalizeResponsesContentItem(
  item: unknown,
  role: string,
): Record<string, unknown> | null {
  if (typeof item === 'string') {
    const text = item.trim();
    return text ? { type: toTextBlockType(role), text } : null;
  }

  if (!isRecord(item)) return null;

  const type = asTrimmedString(item.type).toLowerCase();
  if (!type) {
    const text = asTrimmedString(item.text ?? item.content ?? item.output_text);
    return text ? { type: toTextBlockType(role), text } : null;
  }

  if (type === 'input_text' || type === 'output_text' || type === 'text') {
    const text = asTrimmedString(item.text ?? item.content ?? item.output_text);
    if (!text) return null;
    return {
      ...item,
      type: type === 'text' ? toTextBlockType(role) : type,
      text,
    };
  }

  if (type === 'input_image' || type === 'image_url') {
    const imageUrl = normalizeImageUrlValue(item.image_url ?? item.url);
    if (!imageUrl) return null;
    return {
      ...item,
      type: 'input_image',
      image_url: imageUrl,
    };
  }

  if (type === 'input_audio') {
    const inputAudio = normalizeAudioInputValue(item.input_audio);
    if (!inputAudio) return null;
    return {
      ...item,
      type: 'input_audio',
      input_audio: inputAudio,
    };
  }

  if (type === 'function_call' || type === 'function_call_output') {
    return item;
  }

  return item;
}

export function normalizeResponsesMessageContent(content: unknown, role: string): unknown {
  if (Array.isArray(content)) {
    const normalized = content
      .map((item) => normalizeResponsesContentItem(item, role))
      .filter((item): item is Record<string, unknown> => !!item);
    return normalized.length > 0 ? normalized : content;
  }

  const single = normalizeResponsesContentItem(content, role);
  if (single) return [single];
  return content;
}

function toResponsesInputMessageFromText(text: string): Record<string, unknown> {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

export function normalizeResponsesMessageItem(item: Record<string, unknown>): Record<string, unknown> {
  const type = asTrimmedString(item.type).toLowerCase();
  if (type === 'function_call' || type === 'function_call_output') {
    return item;
  }

  const role = asTrimmedString(item.role).toLowerCase() || 'user';
  const normalizedContent = normalizeResponsesMessageContent(item.content ?? item.text, role);

  if (type === 'message') {
    return {
      ...item,
      role,
      content: normalizedContent,
    };
  }

  if (asTrimmedString(item.role)) {
    return {
      type: 'message',
      role,
      content: normalizedContent,
    };
  }

  if (typeof item.content === 'string') {
    const text = item.content.trim();
    return text ? toResponsesInputMessageFromText(text) : item;
  }

  return item;
}

export function normalizeResponsesInputForCompatibility(input: unknown): unknown {
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

function extractTextFromResponsesContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!isRecord(item)) return '';
      return asTrimmedString(item.text ?? item.content ?? item.output_text);
    })
    .filter((item) => item.length > 0)
    .join('\n');
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
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

function normalizeToolMessageContent(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) {
    const normalized = normalizeResponsesMessageContent(raw, 'user');
    const text = extractTextFromResponsesContent(normalized);
    return text || safeJsonStringify(raw);
  }
  if (isRecord(raw)) {
    const normalized = normalizeResponsesMessageContent(raw, 'user');
    const text = extractTextFromResponsesContent(normalized);
    return text || safeJsonStringify(raw);
  }
  return '';
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
      const normalized = normalizeResponsesMessageContent(item.content, 'user');
      const content = extractTextFromResponsesContent(normalized).trim();
      if (content) systemContents.push(content);
      continue;
    }

    if (role === 'assistant') {
      const normalizedAssistantContent = normalizeResponsesMessageContent(item.content, 'assistant');
      if (Array.isArray(normalizedAssistantContent) && normalizedAssistantContent.length > 0) {
        inputItems.push({
          type: 'message',
          role: 'assistant',
          content: normalizedAssistantContent,
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

    const normalizedUserContent = normalizeResponsesMessageContent(item.content, 'user');
    if (Array.isArray(normalizedUserContent) && normalizedUserContent.length > 0) {
      inputItems.push({
        type: 'message',
        role: 'user',
        content: normalizedUserContent,
      });
    }
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
  if (openaiBody.tools !== undefined) body.tools = openaiBody.tools;
  if (openaiBody.tool_choice !== undefined) body.tool_choice = openaiBody.tool_choice;

  return {
    ...body,
    input: normalizeResponsesInputForCompatibility(body.input),
  };
}

export function sanitizeResponsesBodyForProxy(
  body: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  let normalized: Record<string, unknown> = {
    ...body,
    model: modelName,
    stream,
  };

  if (normalized.input === undefined) {
    if (Array.isArray((normalized as Record<string, unknown>).messages)) {
      normalized = convertOpenAiBodyToResponsesBody(normalized, modelName, stream);
    } else {
      const prompt = asTrimmedString((normalized as Record<string, unknown>).prompt);
      if (prompt) {
        normalized = {
          ...normalized,
          input: [toResponsesInputMessageFromText(prompt)],
        };
      }
    }
  } else {
    normalized = {
      ...normalized,
      input: normalizeResponsesInputForCompatibility(normalized.input),
    };
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
