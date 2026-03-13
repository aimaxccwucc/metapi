import {
  applyGeminiGenerateContentAggregate,
  createGeminiGenerateContentAggregateState,
  type GeminiGenerateContentAggregateState,
} from './aggregator.js';
import { serializeGeminiAggregateResponse } from './outbound.js';

type ParsedSsePayloads = {
  events: unknown[];
  rest: string;
};

type GeminiGenerateContentStreamFormat = 'sse' | 'json';

type ParsedGeminiStreamPayload = {
  format: GeminiGenerateContentStreamFormat;
  events: unknown[];
  rest: string;
};

type AppliedGeminiStreamPayloads = ParsedSsePayloads & {
  state: GeminiGenerateContentAggregateState;
};

function serializeSsePayload(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function parseSsePayloads(buffer: string): ParsedSsePayloads {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const events: unknown[] = [];
  let rest = normalized;

  while (true) {
    const boundary = rest.indexOf('\n\n');
    if (boundary < 0) break;

    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    if (!block.trim()) continue;

    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();

    if (!data || data === '[DONE]') continue;

    try {
      events.push(JSON.parse(data));
    } catch {
      // Ignore malformed event payloads so aggregation remains tolerant.
    }
  }

  return { events, rest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonArrayPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) return [payload];
  return [];
}

function parseGeminiStreamPayload(
  payload: unknown,
  contentType?: string | null,
): ParsedGeminiStreamPayload {
  if (geminiGenerateContentStream.isSseContentType(contentType)) {
    const parsed = parseSsePayloads(String(payload ?? ''));
    return {
      format: 'sse',
      events: parsed.events,
      rest: parsed.rest,
    };
  }

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed) {
      try {
        const parsedJson = JSON.parse(trimmed);
        return {
          format: 'json',
          events: parseJsonArrayPayload(parsedJson),
          rest: '',
        };
      } catch {
        const parsed = parseSsePayloads(payload);
        return {
          format: 'sse',
          events: parsed.events,
          rest: parsed.rest,
        };
      }
    }
    return {
      format: 'json',
      events: [],
      rest: '',
    };
  }

  return {
    format: 'json',
    events: parseJsonArrayPayload(payload),
    rest: '',
  };
}

function applyParsedPayloadToAggregate(
  state: GeminiGenerateContentAggregateState,
  parsed: ParsedGeminiStreamPayload,
): AppliedGeminiStreamPayloads {
  for (const event of parsed.events) {
    applyGeminiGenerateContentAggregate(state, event);
  }

  return {
    events: parsed.events,
    rest: parsed.rest,
    state,
  };
}

function applyJsonPayloadToAggregate(
  state: GeminiGenerateContentAggregateState,
  payload: unknown,
): GeminiGenerateContentAggregateState {
  applyParsedPayloadToAggregate(state, parseGeminiStreamPayload(payload, 'application/json'));
  return state;
}

function applySsePayloadsToAggregate(
  state: GeminiGenerateContentAggregateState,
  buffer: string,
): AppliedGeminiStreamPayloads {
  return applyParsedPayloadToAggregate(state, parseGeminiStreamPayload(buffer, 'text/event-stream'));
}

function consumeUpstreamSseBuffer(
  state: GeminiGenerateContentAggregateState,
  buffer: string,
): AppliedGeminiStreamPayloads & { lines: string[] } {
  const applied = applySsePayloadsToAggregate(state, buffer);
  return {
    ...applied,
    lines: applied.events.map((event) => serializeAggregateSsePayload(event)),
  };
}

function serializeAggregateJsonPayload(
  payload: GeminiGenerateContentAggregateState | unknown,
): unknown {
  return serializeGeminiAggregateResponse(payload);
}

function serializeAggregateSsePayload(
  payload: GeminiGenerateContentAggregateState | unknown,
): string {
  return serializeSsePayload(serializeAggregateJsonPayload(payload));
}

function serializeAggregatePayload(
  payload: GeminiGenerateContentAggregateState | unknown,
  format: GeminiGenerateContentStreamFormat = 'json',
): unknown {
  return format === 'sse'
    ? serializeAggregateSsePayload(payload)
    : serializeAggregateJsonPayload(payload);
}

function serializeUpstreamJsonPayload(
  state: GeminiGenerateContentAggregateState,
  payload: unknown,
  streamAction = false,
): unknown {
  if (streamAction) {
    return parseJsonArrayPayload(payload).map((event) => {
      applyGeminiGenerateContentAggregate(state, event);
      return serializeAggregateJsonPayload(event);
    });
  }

  applyJsonPayloadToAggregate(state, payload);
  return serializeAggregateJsonPayload(state);
}

export const geminiGenerateContentStream = {
  isSseContentType(contentType: string | null | undefined): boolean {
    return (contentType || '').toLowerCase().includes('text/event-stream');
  },

  parseJsonArrayPayload,
  parseGeminiStreamPayload,
  parseSsePayloads,
  serializeSsePayload,
  serializeAggregateJsonPayload,
  serializeAggregatePayload,
  serializeAggregateSsePayload,
  serializeUpstreamJsonPayload,
  applyParsedPayloadToAggregate,
  applyJsonPayloadToAggregate,
  applySsePayloadsToAggregate,
  consumeUpstreamSseBuffer,

  createAggregateState(): GeminiGenerateContentAggregateState {
    return createGeminiGenerateContentAggregateState();
  },

  applyAggregate(state: GeminiGenerateContentAggregateState, payload: unknown): GeminiGenerateContentAggregateState {
    return applyGeminiGenerateContentAggregate(state, payload);
  },
};

export {
  applyParsedPayloadToAggregate,
  applyJsonPayloadToAggregate,
  applySsePayloadsToAggregate,
  parseGeminiStreamPayload,
  parseJsonArrayPayload,
  parseSsePayloads,
  serializeAggregateJsonPayload,
  serializeAggregatePayload,
  serializeAggregateSsePayload,
  serializeUpstreamJsonPayload,
  serializeSsePayload,
  consumeUpstreamSseBuffer,
};
export type {
  AppliedGeminiStreamPayloads,
  GeminiGenerateContentStreamFormat,
  ParsedGeminiStreamPayload,
  ParsedSsePayloads,
};
