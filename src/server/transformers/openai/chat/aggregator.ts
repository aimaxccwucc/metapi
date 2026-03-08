import { type NormalizedFinalResponse, type NormalizedStreamEvent } from '../../shared/normalized.js';
import type {
  OpenAiChatNormalizedFinalResponse,
  OpenAiChatNormalizedStreamEvent,
  OpenAiChatUsageDetails,
} from './model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function pushUniqueAnnotation(
  annotations: Array<Record<string, unknown>>,
  seenUrls: Set<string>,
  candidate: unknown,
) {
  if (!isRecord(candidate)) return;
  const citation = isRecord(candidate.url_citation) ? candidate.url_citation : null;
  const url = citation && typeof citation.url === 'string' ? citation.url.trim() : '';
  if (!url || seenUrls.has(url)) return;
  seenUrls.add(url);
  annotations.push(candidate);
}

function mergeUsageDetails(
  target: OpenAiChatUsageDetails | undefined,
  next: OpenAiChatUsageDetails | undefined,
): OpenAiChatUsageDetails | undefined {
  if (!target && !next) return undefined;
  return {
    ...(target || {}),
    ...(next || {}),
  };
}

export type OpenAiChatAggregateState = {
  content: string[];
  reasoning: string[];
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  annotations: Array<Record<string, unknown>>;
  annotationUrls: Set<string>;
  citations: Set<string>;
  usageDetails?: OpenAiChatUsageDetails;
};

export function createOpenAiChatAggregateState(): OpenAiChatAggregateState {
  return {
    content: [],
    reasoning: [],
    toolCalls: [],
    finishReason: null,
    annotations: [],
    annotationUrls: new Set<string>(),
    citations: new Set<string>(),
    usageDetails: undefined,
  };
}

export function applyOpenAiChatStreamEvent(
  state: OpenAiChatAggregateState,
  event: OpenAiChatNormalizedStreamEvent,
): OpenAiChatAggregateState {
  if (event.contentDelta) state.content.push(event.contentDelta);
  if (event.reasoningDelta) state.reasoning.push(event.reasoningDelta);
  if (event.finishReason !== undefined) state.finishReason = event.finishReason ?? null;
  if (Array.isArray(event.toolCallDeltas)) {
    for (const delta of event.toolCallDeltas) {
      if (!delta.id && !delta.name && !delta.argumentsDelta) continue;
      const index = Number.isFinite(delta.index) ? Math.max(0, Math.trunc(delta.index)) : state.toolCalls.length;
      while (state.toolCalls.length <= index) {
        state.toolCalls.push({ id: '', name: '', arguments: '' });
      }
      const existing = state.toolCalls[index];
      if (delta.id) existing.id = delta.id;
      if (delta.name) existing.name = delta.name;
      if (delta.argumentsDelta) existing.arguments += delta.argumentsDelta;
    }
  }
  if (Array.isArray(event.annotations)) {
    for (const annotation of event.annotations) {
      pushUniqueAnnotation(state.annotations, state.annotationUrls, annotation);
    }
  }
  if (Array.isArray(event.citations)) {
    for (const citation of event.citations) {
      if (typeof citation === 'string' && citation.trim()) {
        state.citations.add(citation.trim());
      }
    }
  }
  state.usageDetails = mergeUsageDetails(state.usageDetails, event.usageDetails);
  return state;
}

export function finalizeOpenAiChatAggregate(
  state: OpenAiChatAggregateState,
  normalized: OpenAiChatNormalizedFinalResponse,
): OpenAiChatNormalizedFinalResponse {
  const mergedToolCalls = state.toolCalls.filter((item) => item.id || item.name || item.arguments);
  if (
    state.content.length === 0
    && state.reasoning.length === 0
    && mergedToolCalls.length === 0
    && state.annotations.length === 0
    && state.citations.size === 0
    && !state.usageDetails
  ) {
    return normalized;
  }
  return {
    ...normalized,
    content: state.content.join('') || normalized.content,
    reasoningContent: state.reasoning.join('') || normalized.reasoningContent,
    finishReason: state.finishReason ?? normalized.finishReason,
    toolCalls: mergedToolCalls.length > 0 ? mergedToolCalls : normalized.toolCalls,
    annotations: state.annotations.length > 0 ? state.annotations : normalized.annotations,
    citations: state.citations.size > 0 ? Array.from(state.citations).sort() : normalized.citations,
    usageDetails: mergeUsageDetails(normalized.usageDetails, state.usageDetails),
  };
}
