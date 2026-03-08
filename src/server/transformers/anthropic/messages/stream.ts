import {
  createClaudeDownstreamContext,
  createStreamTransformContext,
  normalizeStopReason,
  normalizeUpstreamStreamEvent,
  pullSseEventsWithDone,
  type ClaudeDownstreamContext,
  type NormalizedFinalResponse,
  type NormalizedStreamEvent,
  type StreamTransformContext,
} from '../../shared/normalized.js';
import { type AnthropicExtendedStreamEvent } from './aggregator.js';

type AnthropicStreamPayload = Record<string, unknown>;

type ExtendedClaudeDownstreamContext = ClaudeDownstreamContext & {
  thinkingBlockIndex?: number | null;
  pendingSignature?: string | null;
};

export const ANTHROPIC_RAW_SSE_EVENT_NAMES = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error',
]);

function isRecord(value: unknown): value is AnthropicStreamPayload {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function serializeSse(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function isAnthropicRawSseEventName(value: unknown): value is string {
  return typeof value === 'string' && ANTHROPIC_RAW_SSE_EVENT_NAMES.has(value);
}

export function serializeAnthropicRawSseEvent(event: string, data: string): string {
  const dataLines = data.split('\n').map((line) => `data: ${line}`).join('\n');
  if (event) {
    return `event: ${event}\n${dataLines}\n\n`;
  }
  return `${dataLines}\n\n`;
}

function ensureContext(context: ClaudeDownstreamContext): ExtendedClaudeDownstreamContext {
  const extended = context as ExtendedClaudeDownstreamContext;
  if (extended.thinkingBlockIndex === undefined) extended.thinkingBlockIndex = null;
  if (extended.pendingSignature === undefined) extended.pendingSignature = null;
  return extended;
}

export function syncAnthropicRawStreamStateFromEvent(
  eventName: string,
  parsedPayload: unknown,
  streamContext: StreamTransformContext,
  downstreamContext: ClaudeDownstreamContext,
) {
  const context = ensureContext(downstreamContext);
  if (eventName === 'message_start') {
    context.messageStarted = true;
    if (isRecord(parsedPayload) && isRecord(parsedPayload.message)) {
      const message = parsedPayload.message;
      if (typeof message.id === 'string' && message.id.trim().length > 0) {
        streamContext.id = message.id;
      }
      if (typeof message.model === 'string' && message.model.trim().length > 0) {
        streamContext.model = message.model;
      }
    }
    return;
  }

  if (eventName === 'content_block_start') {
    context.contentBlockStarted = true;
    return;
  }

  if (eventName === 'content_block_stop') {
    context.contentBlockStarted = false;
    return;
  }

  if (eventName === 'message_stop') {
    context.doneSent = true;
  }
}

function buildClaudeMessageId(sourceId: string): string {
  if (sourceId.startsWith('msg_')) return sourceId;
  const sanitized = sourceId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `msg_${sanitized || Date.now()}`;
}

function ensureClaudeStartEvents(
  streamContext: StreamTransformContext,
  context: ExtendedClaudeDownstreamContext,
): string[] {
  if (context.messageStarted) return [];
  context.messageStarted = true;
  return [
    serializeSse('message_start', {
      type: 'message_start',
      message: {
        id: buildClaudeMessageId(streamContext.id),
        type: 'message',
        role: 'assistant',
        model: streamContext.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    }),
  ];
}

function closeTextBlock(context: ExtendedClaudeDownstreamContext): string[] {
  if (context.textBlockIndex === null || context.textBlockIndex === undefined) return [];
  const index = context.textBlockIndex;
  context.textBlockIndex = null;
  context.contentBlockStarted = false;
  return [
    serializeSse('content_block_stop', {
      type: 'content_block_stop',
      index,
    }),
  ];
}

function emitPendingSignature(context: ExtendedClaudeDownstreamContext): string[] {
  if (!context.pendingSignature || context.thinkingBlockIndex === null || context.thinkingBlockIndex === undefined) {
    return [];
  }
  const signature = context.pendingSignature;
  context.pendingSignature = null;
  return [
    serializeSse('content_block_delta', {
      type: 'content_block_delta',
      index: context.thinkingBlockIndex,
      delta: {
        type: 'signature_delta',
        signature,
      },
    }),
  ];
}

function closeThinkingBlock(context: ExtendedClaudeDownstreamContext): string[] {
  if (context.thinkingBlockIndex === null || context.thinkingBlockIndex === undefined) return [];
  const index = context.thinkingBlockIndex;
  const events = [
    ...emitPendingSignature(context),
    serializeSse('content_block_stop', {
      type: 'content_block_stop',
      index,
    }),
  ];
  context.thinkingBlockIndex = null;
  return events;
}

function closeToolBlocks(context: ExtendedClaudeDownstreamContext): string[] {
  const openBlocks = Object.values(context.toolBlocks)
    .filter((item) => item.open)
    .sort((a, b) => a.contentIndex - b.contentIndex);

  if (openBlocks.length <= 0) return [];

  const events: string[] = [];
  for (const block of openBlocks) {
    block.open = false;
    events.push(serializeSse('content_block_stop', {
      type: 'content_block_stop',
      index: block.contentIndex,
    }));
  }
  return events;
}

function closeAllBlocks(context: ExtendedClaudeDownstreamContext): string[] {
  return [
    ...closeTextBlock(context),
    ...closeThinkingBlock(context),
    ...closeToolBlocks(context),
  ];
}

function ensureTextBlockStart(context: ExtendedClaudeDownstreamContext): string[] {
  if (context.textBlockIndex !== null && context.textBlockIndex !== undefined) return [];
  const index = context.nextContentBlockIndex;
  context.nextContentBlockIndex += 1;
  context.textBlockIndex = index;
  context.contentBlockStarted = true;
  return [
    serializeSse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'text',
        text: '',
      },
    }),
  ];
}

function ensureThinkingBlockStart(context: ExtendedClaudeDownstreamContext): string[] {
  if (context.thinkingBlockIndex !== null && context.thinkingBlockIndex !== undefined) return [];
  const index = context.nextContentBlockIndex;
  context.nextContentBlockIndex += 1;
  context.thinkingBlockIndex = index;
  return [
    serializeSse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'thinking',
        thinking: '',
      },
    }),
  ];
}

function ensureToolBlockStart(
  context: ExtendedClaudeDownstreamContext,
  toolDelta: NonNullable<AnthropicExtendedStreamEvent['toolCallDeltas']>[number],
): { events: string[]; contentIndex: number } {
  const toolSlot = Number.isFinite(toolDelta.index) ? Math.max(0, Math.trunc(toolDelta.index)) : 0;
  let state = context.toolBlocks[toolSlot];
  if (!state) {
    state = {
      contentIndex: context.nextContentBlockIndex,
      id: toolDelta.id || `toolu_${toolSlot}`,
      name: toolDelta.name || `tool_${toolSlot}`,
      open: false,
    };
    context.nextContentBlockIndex += 1;
    context.toolBlocks[toolSlot] = state;
  } else {
    if (toolDelta.id) state.id = toolDelta.id;
    if (toolDelta.name) state.name = toolDelta.name;
  }

  const events: string[] = [];
  if (!state.open) {
    state.open = true;
    events.push(serializeSse('content_block_start', {
      type: 'content_block_start',
      index: state.contentIndex,
      content_block: {
        type: 'tool_use',
        id: state.id,
        name: state.name,
        input: {},
      },
    }));
  }

  return { events, contentIndex: state.contentIndex };
}

function buildDoneEvents(
  streamContext: StreamTransformContext,
  context: ExtendedClaudeDownstreamContext,
  finishReason?: string | null,
): string[] {
  if (context.doneSent) return [];

  const events = [
    ...ensureClaudeStartEvents(streamContext, context),
    ...closeAllBlocks(context),
    serializeSse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: toClaudeStopReason(finishReason),
        stop_sequence: null,
      },
      usage: {
        output_tokens: 0,
      },
    }),
    serializeSse('message_stop', {
      type: 'message_stop',
    }),
  ];
  context.doneSent = true;
  return events;
}

export function serializeAnthropicFinalAsStream(
  normalizedFinal: NormalizedFinalResponse,
  streamContext: StreamTransformContext,
  downstreamContext: ClaudeDownstreamContext,
): string[] {
  streamContext.id = normalizedFinal.id;
  streamContext.model = normalizedFinal.model;
  streamContext.created = normalizedFinal.created;

  const lines = [
    ...anthropicMessagesStream.serializeEvent({ role: 'assistant' }, streamContext, downstreamContext),
  ];

  if (normalizedFinal.reasoningContent) {
    lines.push(
      ...anthropicMessagesStream.serializeEvent(
        { reasoningDelta: normalizedFinal.reasoningContent },
        streamContext,
        downstreamContext,
      ),
    );
  }

  if (normalizedFinal.content) {
    lines.push(
      ...anthropicMessagesStream.serializeEvent(
        { contentDelta: normalizedFinal.content },
        streamContext,
        downstreamContext,
      ),
    );
  }

  lines.push(
    ...anthropicMessagesStream.serializeEvent(
      { finishReason: normalizedFinal.finishReason },
      streamContext,
      downstreamContext,
    ),
  );

  return lines;
}

export function serializeAnthropicUpstreamFinalAsStream(
  payload: unknown,
  modelName: string,
  fallbackText: string,
  normalizeFinal: (payload: unknown, modelName: string, fallbackText?: string) => NormalizedFinalResponse,
  streamContext: StreamTransformContext,
  downstreamContext: ClaudeDownstreamContext,
): string[] {
  const normalizedFinal = normalizeFinal(payload, modelName, fallbackText);
  return serializeAnthropicFinalAsStream(normalizedFinal, streamContext, downstreamContext);
}

function toClaudeStopReason(finishReason: string | null | undefined): string {
  const normalized = normalizeStopReason(finishReason);
  if (normalized === 'length') return 'max_tokens';
  if (normalized === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

function normalizeAnthropicRawEvent(
  payload: AnthropicStreamPayload,
  context: StreamTransformContext,
  fallbackModel: string,
): AnthropicExtendedStreamEvent | null {
  const type = asTrimmedString(payload.type);
  if (!type) return null;

  if (type === 'message_start' && isRecord(payload.message)) {
    const message = payload.message;
    if (asTrimmedString(message.id)) context.id = asTrimmedString(message.id);
    if (asTrimmedString(message.model)) context.model = asTrimmedString(message.model);
    else if (!context.model) context.model = fallbackModel;
    return { role: 'assistant' };
  }

  if (type === 'content_block_start' && isRecord(payload.content_block)) {
    const contentBlock = payload.content_block;
    const blockType = asTrimmedString(contentBlock.type);
    const index = typeof payload.index === 'number' ? payload.index : undefined;

    if (blockType === 'thinking') {
      return {
        anthropic: {
          startBlock: {
            kind: 'thinking',
            index,
          },
        },
      };
    }

    if (blockType === 'redacted_thinking') {
      return {
        anthropic: {
          startBlock: {
            kind: 'redacted_thinking',
            index,
          },
          redactedThinkingData: asTrimmedString(contentBlock.data),
        },
      };
    }

    if (blockType === 'tool_use') {
      return {
        toolCallDeltas: [{
          index: typeof index === 'number' ? index : 0,
          id: asTrimmedString(contentBlock.id) || undefined,
          name: asTrimmedString(contentBlock.name) || undefined,
        }],
      };
    }
  }

  if (type === 'content_block_delta' && isRecord(payload.delta)) {
    const delta = payload.delta;
    const deltaType = asTrimmedString(delta.type);
    const index = typeof payload.index === 'number' ? payload.index : 0;

    if (deltaType === 'thinking_delta') {
      return {
        reasoningDelta: asTrimmedString(delta.thinking ?? delta.text) || undefined,
      };
    }

    if (deltaType === 'signature_delta') {
      return {
        anthropic: {
          signatureDelta: asTrimmedString(delta.signature) || undefined,
        },
      };
    }

    if (deltaType === 'text_delta') {
      return {
        contentDelta: asTrimmedString(delta.text) || undefined,
      };
    }

    if (deltaType === 'input_json_delta') {
      return {
        toolCallDeltas: [{
          index,
          argumentsDelta: asTrimmedString(delta.partial_json),
        }],
      };
    }
  }

  if (type === 'content_block_stop') {
    return {
      anthropic: {
        stopBlockIndex: typeof payload.index === 'number' ? payload.index : null,
      },
    };
  }

  if (type === 'message_delta' && isRecord(payload.delta)) {
    return {
      finishReason: normalizeStopReason(payload.delta.stop_reason ?? payload.stop_reason),
    };
  }

  if (type === 'message_stop') {
    return { done: true };
  }

  return null;
}

export type AnthropicConsumedSseEvent = {
  handled: boolean;
  lines: string[];
  done: boolean;
  parsedPayload: unknown | null;
};

export function consumeAnthropicSseEvent(
  eventBlock: { event: string; data: string },
  streamContext: StreamTransformContext,
  downstreamContext: ClaudeDownstreamContext,
  fallbackModel: string,
): AnthropicConsumedSseEvent {
  const context = ensureContext(downstreamContext);
  let parsedPayload: unknown = null;

  try {
    parsedPayload = JSON.parse(eventBlock.data);
  } catch {
    parsedPayload = null;
  }

  if (parsedPayload && isRecord(parsedPayload)) {
    const payloadType = typeof parsedPayload.type === 'string' ? parsedPayload.type : '';
    const claudeEventName = isAnthropicRawSseEventName(eventBlock.event)
      ? eventBlock.event
      : (isAnthropicRawSseEventName(payloadType) ? payloadType : '');

    if (claudeEventName) {
      syncAnthropicRawStreamStateFromEvent(
        claudeEventName,
        parsedPayload,
        streamContext,
        context,
      );
      return {
        handled: true,
        lines: [serializeAnthropicRawSseEvent(claudeEventName, eventBlock.data)],
        done: context.doneSent,
        parsedPayload,
      };
    }
  }

  return {
    handled: false,
    lines: [],
    done: false,
    parsedPayload,
  };
}

export const anthropicMessagesStream = {
  createContext(modelName: string): StreamTransformContext {
    return createStreamTransformContext(modelName);
  },
  createDownstreamContext(): ClaudeDownstreamContext {
    return ensureContext(createClaudeDownstreamContext());
  },
  normalizeEvent(payload: unknown, context: StreamTransformContext, modelName: string): AnthropicExtendedStreamEvent {
    if (isRecord(payload)) {
      const anthropicEvent = normalizeAnthropicRawEvent(payload, context, modelName);
      if (anthropicEvent) return anthropicEvent;
    }
    return normalizeUpstreamStreamEvent(payload, context, modelName) as AnthropicExtendedStreamEvent;
  },
  serializeEvent(
    event: NormalizedStreamEvent,
    streamContext: StreamTransformContext,
    downstreamContext: ClaudeDownstreamContext,
  ): string[] {
    const context = ensureContext(downstreamContext);
    const anthropicEvent = event as AnthropicExtendedStreamEvent;
    const events: string[] = [];

    const needsStart = (
      event.role === 'assistant'
      || !!event.contentDelta
      || !!event.reasoningDelta
      || (Array.isArray(event.toolCallDeltas) && event.toolCallDeltas.length > 0)
      || !!anthropicEvent.anthropic
      || !!event.finishReason
      || !!event.done
    );
    if (needsStart) {
      events.push(...ensureClaudeStartEvents(streamContext, context));
    }

    if (anthropicEvent.anthropic?.signatureDelta) {
      if (context.thinkingBlockIndex !== null && context.thinkingBlockIndex !== undefined) {
        events.push(serializeSse('content_block_delta', {
          type: 'content_block_delta',
          index: context.thinkingBlockIndex,
          delta: {
            type: 'signature_delta',
            signature: anthropicEvent.anthropic.signatureDelta,
          },
        }));
      } else {
        context.pendingSignature = anthropicEvent.anthropic.signatureDelta;
      }
    }

    if (anthropicEvent.anthropic?.redactedThinkingData) {
      events.push(...closeAllBlocks(context));
      const index = context.nextContentBlockIndex;
      context.nextContentBlockIndex += 1;
      events.push(serializeSse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'redacted_thinking',
          data: anthropicEvent.anthropic.redactedThinkingData,
        },
      }));
      events.push(serializeSse('content_block_stop', {
        type: 'content_block_stop',
        index,
      }));
    }

    if (event.reasoningDelta) {
      events.push(...closeToolBlocks(context));
      events.push(...closeTextBlock(context));
      events.push(...ensureThinkingBlockStart(context));
      events.push(serializeSse('content_block_delta', {
        type: 'content_block_delta',
        index: context.thinkingBlockIndex ?? 0,
        delta: {
          type: 'thinking_delta',
          thinking: event.reasoningDelta,
        },
      }));
    }

    if (Array.isArray(event.toolCallDeltas) && event.toolCallDeltas.length > 0) {
      events.push(...closeTextBlock(context));
      events.push(...closeThinkingBlock(context));
      for (const toolDelta of event.toolCallDeltas) {
        const toolBlock = ensureToolBlockStart(context, toolDelta);
        events.push(...toolBlock.events);
        if (toolDelta.argumentsDelta) {
          events.push(serializeSse('content_block_delta', {
            type: 'content_block_delta',
            index: toolBlock.contentIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: toolDelta.argumentsDelta,
            },
          }));
        }
      }
    }

    if (event.contentDelta) {
      events.push(...closeToolBlocks(context));
      events.push(...closeThinkingBlock(context));
      events.push(...ensureTextBlockStart(context));
      events.push(serializeSse('content_block_delta', {
        type: 'content_block_delta',
        index: context.textBlockIndex ?? 0,
        delta: {
          type: 'text_delta',
          text: event.contentDelta,
        },
      }));
    }

    if (
      anthropicEvent.anthropic?.stopBlockIndex !== undefined
      && anthropicEvent.anthropic.stopBlockIndex !== null
    ) {
      const targetIndex = anthropicEvent.anthropic.stopBlockIndex;
      if (context.thinkingBlockIndex === targetIndex) {
        events.push(...closeThinkingBlock(context));
      }
      if (context.textBlockIndex === targetIndex) {
        events.push(...closeTextBlock(context));
      }
      const matchingToolBlock = Object.values(context.toolBlocks).find((item) => item.open && item.contentIndex === targetIndex);
      if (matchingToolBlock) {
        matchingToolBlock.open = false;
        events.push(serializeSse('content_block_stop', {
          type: 'content_block_stop',
          index: matchingToolBlock.contentIndex,
        }));
      }
    }

    if (event.finishReason || event.done) {
      events.push(...buildDoneEvents(streamContext, context, event.finishReason));
    }

    return events;
  },
  serializeDone(
    streamContext: StreamTransformContext,
    downstreamContext: ClaudeDownstreamContext,
  ): string[] {
    const context = ensureContext(downstreamContext);
    return buildDoneEvents(streamContext, context, 'stop');
  },
  pullSseEvents(buffer: string) {
    return pullSseEventsWithDone(buffer);
  },
  consumeAnthropicSseEvent,
  serializeUpstreamFinalAsStream(
    payload: unknown,
    modelName: string,
    fallbackText: string,
    normalizeFinal: (payload: unknown, modelName: string, fallbackText?: string) => NormalizedFinalResponse,
    streamContext: StreamTransformContext,
    downstreamContext: ClaudeDownstreamContext,
  ) {
    return serializeAnthropicUpstreamFinalAsStream(
      payload,
      modelName,
      fallbackText,
      normalizeFinal,
      streamContext,
      downstreamContext,
    );
  },
};
