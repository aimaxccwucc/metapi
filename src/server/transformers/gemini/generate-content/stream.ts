import {
  applyGeminiGenerateContentAggregate,
  createGeminiGenerateContentAggregateState,
  type GeminiGenerateContentAggregateState,
} from './aggregator.js';

type ParsedSsePayloads = {
  events: unknown[];
  rest: string;
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

export const geminiGenerateContentStream = {
  isSseContentType(contentType: string | null | undefined): boolean {
    return (contentType || '').toLowerCase().includes('text/event-stream');
  },

  parseJsonArrayPayload(payload: unknown): unknown[] {
    return Array.isArray(payload) ? payload : [];
  },

  parseSsePayloads,
  serializeSsePayload,

  createAggregateState(): GeminiGenerateContentAggregateState {
    return createGeminiGenerateContentAggregateState();
  },

  applyAggregate(state: GeminiGenerateContentAggregateState, payload: unknown): GeminiGenerateContentAggregateState {
    return applyGeminiGenerateContentAggregate(state, payload);
  },
};
