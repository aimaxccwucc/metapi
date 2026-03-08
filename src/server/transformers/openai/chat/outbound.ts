import {
  buildSyntheticOpenAiChunks,
  normalizeUpstreamFinalResponse,
  serializeFinalResponse,
  type NormalizedFinalResponse,
} from '../../shared/normalized.js';
import { extractChatResponseExtras } from './helpers.js';
import type { OpenAiChatNormalizedFinalResponse } from './model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeUsagePayload(
  usage: unknown,
  normalized: OpenAiChatNormalizedFinalResponse,
): Record<string, unknown> | undefined {
  const merged = isRecord(usage) ? { ...usage } : {};
  const usagePayload = normalized.usagePayload && isRecord(normalized.usagePayload)
    ? normalized.usagePayload
    : null;

  if (usagePayload) {
    for (const [key, value] of Object.entries(usagePayload)) {
      if (key === 'prompt_tokens' || key === 'completion_tokens' || key === 'total_tokens') continue;
      if (merged[key] === undefined) merged[key] = value;
    }
  }

  if (normalized.usageDetails?.prompt_tokens_details) {
    merged.prompt_tokens_details = normalized.usageDetails.prompt_tokens_details;
  }
  if (normalized.usageDetails?.completion_tokens_details) {
    merged.completion_tokens_details = normalized.usageDetails.completion_tokens_details;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export const openAiChatOutbound = {
  normalizeFinal(payload: unknown, modelName: string, fallbackText = ''): OpenAiChatNormalizedFinalResponse {
    return {
      ...normalizeUpstreamFinalResponse(payload, modelName, fallbackText),
      ...extractChatResponseExtras(payload),
    };
  },
  serializeFinal(normalized: NormalizedFinalResponse, usage?: unknown) {
    const chatNormalized = normalized as OpenAiChatNormalizedFinalResponse;
    const payload = serializeFinalResponse(
      'openai',
      normalized,
      usage as { promptTokens: number; completionTokens: number; totalTokens: number },
    ) as Record<string, unknown>;

    if (Array.isArray(chatNormalized.citations) && chatNormalized.citations.length > 0) {
      payload.citations = chatNormalized.citations;
    }

    if (Array.isArray(chatNormalized.annotations) && chatNormalized.annotations.length > 0) {
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const firstChoice = choices[0];
      if (isRecord(firstChoice) && isRecord(firstChoice.message)) {
        firstChoice.message.annotations = chatNormalized.annotations;
      }
    }

    const mergedUsage = mergeUsagePayload(payload.usage, chatNormalized);
    if (mergedUsage) {
      payload.usage = {
        ...(isRecord(payload.usage) ? payload.usage : {}),
        ...mergedUsage,
      };
    }

    return payload;
  },
  buildSyntheticChunks(normalized: NormalizedFinalResponse) {
    const chunks = buildSyntheticOpenAiChunks(normalized);
    const chatNormalized = normalized as OpenAiChatNormalizedFinalResponse;
    if (chunks.length <= 0) return chunks;

    if (Array.isArray(chatNormalized.citations) && chatNormalized.citations.length > 0) {
      chunks[0] = {
        ...chunks[0],
        citations: chatNormalized.citations,
      };
    }

    if (Array.isArray(chatNormalized.annotations) && chatNormalized.annotations.length > 0) {
      const firstChunk = isRecord(chunks[0]) ? chunks[0] : null;
      const firstChoice = firstChunk && Array.isArray(firstChunk.choices) ? firstChunk.choices[0] : null;
      if (isRecord(firstChoice) && isRecord(firstChoice.delta)) {
        firstChoice.delta.annotations = chatNormalized.annotations;
      }
    }

    return chunks;
  },
};
