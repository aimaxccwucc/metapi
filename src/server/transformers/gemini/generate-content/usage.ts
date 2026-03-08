import { createEmptyNormalizedUsage, mergeNormalizedUsage, type NormalizedUsage } from '../../shared/normalized.js';
import { type GeminiGenerateContentAggregateState } from './aggregator.js';

type GeminiRecord = Record<string, unknown>;

function isRecord(value: unknown): value is GeminiRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAggregateState(value: unknown): value is GeminiGenerateContentAggregateState {
  return isRecord(value) && Array.isArray(value.parts) && isRecord(value.usage);
}

export function extractGeminiUsage(payload: unknown): NormalizedUsage {
  const usageMetadata = isAggregateState(payload)
    ? payload.usage
    : (isRecord(payload) && isRecord(payload.usageMetadata) ? payload.usageMetadata : null);

  if (!usageMetadata) {
    return createEmptyNormalizedUsage();
  }

  const promptTokens = typeof usageMetadata.promptTokenCount === 'number'
    ? usageMetadata.promptTokenCount
    : 0;
  const candidatesTokenCount = typeof usageMetadata.candidatesTokenCount === 'number'
    ? usageMetadata.candidatesTokenCount
    : 0;
  const thoughtsTokenCount = typeof usageMetadata.thoughtsTokenCount === 'number'
    ? usageMetadata.thoughtsTokenCount
    : 0;
  const completionTokens = candidatesTokenCount + thoughtsTokenCount;
  const totalTokens = typeof usageMetadata.totalTokenCount === 'number'
    ? usageMetadata.totalTokenCount
    : promptTokens + completionTokens;
  const cachedTokens = typeof usageMetadata.cachedContentTokenCount === 'number'
    ? usageMetadata.cachedContentTokenCount
    : 0;
  const reasoningTokens = thoughtsTokenCount;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    reasoningTokens,
  };
}

export const geminiGenerateContentUsage = {
  empty: createEmptyNormalizedUsage,
  fromPayload: extractGeminiUsage,
  merge: mergeNormalizedUsage,
};
