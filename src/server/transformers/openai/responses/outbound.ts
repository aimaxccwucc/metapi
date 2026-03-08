import {
  normalizeUpstreamFinalResponse,
  type NormalizedFinalResponse,
} from '../../shared/normalized.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

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

export type ResponsesUsageSummary = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ResponsesToolCall = {
  id: string;
  name: string;
  arguments: string;
};

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
      .filter((item): item is ResponsesToolCall => !!item);
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
      .filter((item): item is ResponsesToolCall => !!item);
  }

  return [];
}

export function normalizeResponsesFinalPayload(
  payload: unknown,
  modelName: string,
  fallbackText = '',
): NormalizedFinalResponse {
  return normalizeUpstreamFinalResponse(payload, modelName, fallbackText);
}

export function serializeResponsesFinalPayload(input: {
  upstreamPayload: unknown;
  normalized: NormalizedFinalResponse;
  usage: ResponsesUsageSummary;
}): Record<string, unknown> {
  const { upstreamPayload, normalized, usage } = input;
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
  if (normalized.reasoningContent) {
    output.push({
      id: ensureMessageId(`${normalizedId}_reasoning`),
      type: 'reasoning',
      status: 'completed',
      summary: [{
        type: 'summary_text',
        text: normalized.reasoningContent,
      }],
    });
  }
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

export const openAiResponsesOutbound = {
  normalizeFinal: normalizeResponsesFinalPayload,
  serializeFinal: serializeResponsesFinalPayload,
};

export {
  serializeResponsesFinalPayload as toResponsesPayload,
};
