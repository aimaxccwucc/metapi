import {
  createClaudeDownstreamContext,
  createStreamTransformContext,
  normalizeUpstreamStreamEvent,
  pullSseEventsWithDone,
  serializeNormalizedStreamEvent,
  serializeStreamDone,
  type ClaudeDownstreamContext,
  type StreamTransformContext,
} from '../../shared/normalized.js';
import { extractChatResponseExtras } from './helpers.js';
import type { OpenAiChatNormalizedStreamEvent } from './model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseSerializedSse(lines: string[]): Array<{ index: number; payload: Record<string, unknown> }> {
  return lines
    .map((line, index) => {
      if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') return null;
      try {
        return {
          index,
          payload: JSON.parse(line.slice(6)) as Record<string, unknown>,
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is { index: number; payload: Record<string, unknown> } => !!item);
}

export const openAiChatStream = {
  createContext(modelName: string): StreamTransformContext {
    return createStreamTransformContext(modelName);
  },
  normalizeEvent(payload: unknown, context: StreamTransformContext, modelName: string): OpenAiChatNormalizedStreamEvent {
    return {
      ...normalizeUpstreamStreamEvent(payload, context, modelName),
      ...extractChatResponseExtras(payload),
    };
  },
  serializeEvent(
    event: OpenAiChatNormalizedStreamEvent,
    context: StreamTransformContext,
    downstreamContext?: ClaudeDownstreamContext,
  ): string[] {
    const lines = serializeNormalizedStreamEvent(
      'openai',
      event,
      context,
      downstreamContext ?? createClaudeDownstreamContext(),
    );

    if (
      (!Array.isArray(event.annotations) || event.annotations.length <= 0)
      && (!Array.isArray(event.citations) || event.citations.length <= 0)
      && !event.usagePayload
      && !event.usageDetails
    ) {
      return lines;
    }

    const parsedEvents = parseSerializedSse(lines);
    if (parsedEvents.length <= 0) return lines;

    for (const parsed of parsedEvents) {
      const payload = parsed.payload;
      if (Array.isArray(event.citations) && event.citations.length > 0) {
        payload.citations = event.citations;
      }

      const firstChoice = Array.isArray(payload.choices) ? payload.choices[0] : null;
      if (Array.isArray(event.annotations) && event.annotations.length > 0 && isRecord(firstChoice) && isRecord(firstChoice.delta)) {
        firstChoice.delta.annotations = event.annotations;
      }

      if (event.usagePayload || event.usageDetails) {
        payload.usage = {
          ...(isRecord(event.usagePayload) ? event.usagePayload : {}),
          ...(event.usageDetails?.prompt_tokens_details
            ? { prompt_tokens_details: event.usageDetails.prompt_tokens_details }
            : {}),
          ...(event.usageDetails?.completion_tokens_details
            ? { completion_tokens_details: event.usageDetails.completion_tokens_details }
            : {}),
        };
      }

      lines[parsed.index] = `data: ${JSON.stringify(payload)}\n\n`;
    }

    return lines;
  },
  serializeDone(
    context: StreamTransformContext,
    downstreamContext?: ClaudeDownstreamContext,
  ): string[] {
    return serializeStreamDone(
      'openai',
      context,
      downstreamContext ?? createClaudeDownstreamContext(),
    );
  },
  pullSseEvents(buffer: string) {
    return pullSseEventsWithDone(buffer);
  },
};
