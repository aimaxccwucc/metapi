import { type NormalizedStreamEvent } from '../../shared/normalized.js';

export type AnthropicStreamExtension = {
  signatureDelta?: string;
  redactedThinkingData?: string;
  startBlock?: {
    kind: 'thinking' | 'text' | 'tool_use' | 'redacted_thinking';
    index?: number;
  };
  stopBlockIndex?: number | null;
};

export type AnthropicExtendedStreamEvent = NormalizedStreamEvent & {
  anthropic?: AnthropicStreamExtension;
};

export type AnthropicBlockLifecycleEntry = {
  kind: 'thinking' | 'redacted_thinking';
  phase: 'start' | 'stop';
  index?: number;
};

export type AnthropicMessagesAggregateState = {
  text: string[];
  reasoning: string[];
  redactedReasoning: string[];
  signatures: string[];
  toolCalls: Record<number, { id: string; name: string; arguments: string }>;
  finishReason: string | null;
  pendingSignature: string | null;
  thinkingBlockIndex: number | null;
  redactedBlockIndexes: number[];
  blockLifecycle: AnthropicBlockLifecycleEntry[];
};

export function createAnthropicMessagesAggregateState(): AnthropicMessagesAggregateState {
  return {
    text: [],
    reasoning: [],
    redactedReasoning: [],
    signatures: [],
    toolCalls: {},
    finishReason: null,
    pendingSignature: null,
    thinkingBlockIndex: null,
    redactedBlockIndexes: [],
    blockLifecycle: [],
  };
}

function ensureToolState(
  state: AnthropicMessagesAggregateState,
  index: number,
): { id: string; name: string; arguments: string } {
  if (!state.toolCalls[index]) {
    state.toolCalls[index] = {
      id: `toolu_${index}`,
      name: '',
      arguments: '',
    };
  }
  return state.toolCalls[index];
}

function flushPendingSignature(state: AnthropicMessagesAggregateState): void {
  if (!state.pendingSignature) return;
  state.signatures.push(state.pendingSignature);
  state.pendingSignature = null;
}

function recordBlockStart(
  state: AnthropicMessagesAggregateState,
  kind: AnthropicBlockLifecycleEntry['kind'],
  index?: number,
): void {
  state.blockLifecycle.push({ kind, phase: 'start', index });
  if (kind === 'thinking') {
    state.thinkingBlockIndex = typeof index === 'number' ? index : state.thinkingBlockIndex;
    return;
  }
  if (kind === 'redacted_thinking' && typeof index === 'number') {
    state.redactedBlockIndexes.push(index);
  }
}

function recordBlockStop(state: AnthropicMessagesAggregateState, index: number): void {
  if (state.thinkingBlockIndex === index) {
    state.blockLifecycle.push({ kind: 'thinking', phase: 'stop', index });
    state.thinkingBlockIndex = null;
    flushPendingSignature(state);
    return;
  }

  const redactedIndex = state.redactedBlockIndexes.indexOf(index);
  if (redactedIndex >= 0) {
    state.blockLifecycle.push({ kind: 'redacted_thinking', phase: 'stop', index });
    state.redactedBlockIndexes.splice(redactedIndex, 1);
  }
}

function finalizeOpenBlocks(state: AnthropicMessagesAggregateState): void {
  if (state.thinkingBlockIndex !== null) {
    const thinkingIndex = state.thinkingBlockIndex;
    recordBlockStop(state, thinkingIndex);
  }

  if (state.pendingSignature) {
    flushPendingSignature(state);
  }

  const openRedactedIndexes = [...state.redactedBlockIndexes];
  for (const redactedIndex of openRedactedIndexes) {
    recordBlockStop(state, redactedIndex);
  }
}

export function applyAnthropicMessagesAggregateEvent(
  state: AnthropicMessagesAggregateState,
  event: AnthropicExtendedStreamEvent,
): AnthropicMessagesAggregateState {
  if (event.anthropic?.startBlock?.kind === 'thinking') {
    recordBlockStart(state, 'thinking', event.anthropic.startBlock.index);
  }
  if (event.anthropic?.startBlock?.kind === 'redacted_thinking') {
    if (state.thinkingBlockIndex !== null) {
      recordBlockStop(state, state.thinkingBlockIndex);
    }
    recordBlockStart(state, 'redacted_thinking', event.anthropic.startBlock.index);
  }

  if (event.reasoningDelta) {
    state.reasoning.push(event.reasoningDelta);
  }

  if (event.contentDelta) {
    state.text.push(event.contentDelta);
  }

  if (Array.isArray(event.toolCallDeltas)) {
    for (const toolDelta of event.toolCallDeltas) {
      const toolState = ensureToolState(state, toolDelta.index);
      if (toolDelta.id) toolState.id = toolDelta.id;
      if (toolDelta.name) toolState.name = toolDelta.name;
      if (toolDelta.argumentsDelta) {
        toolState.arguments += toolDelta.argumentsDelta;
      }
    }
  }

  if (event.anthropic?.signatureDelta) {
    if (state.thinkingBlockIndex !== null) {
      state.signatures.push(event.anthropic.signatureDelta);
    } else {
      state.pendingSignature = event.anthropic.signatureDelta;
    }
  }

  if (event.anthropic?.redactedThinkingData) {
    state.redactedReasoning.push(event.anthropic.redactedThinkingData);
  }

  if (
    event.anthropic?.stopBlockIndex !== undefined
    && event.anthropic.stopBlockIndex !== null
  ) {
    recordBlockStop(state, event.anthropic.stopBlockIndex);
  }

  if (event.finishReason) {
    finalizeOpenBlocks(state);
    state.finishReason = event.finishReason;
  }

  if (event.done) {
    finalizeOpenBlocks(state);
  }

  return state;
}
