import { createEmptyNormalizedUsage, mergeNormalizedUsage, type NormalizedUsage } from '../../shared/normalized.js';

type AnthropicRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnthropicRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toPositiveInt(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.trunc(numberValue));
}

function resolveAnthropicUsageRecord(payload: unknown): AnthropicRecord | null {
  if (isRecord(payload) && isRecord(payload.usage)) return payload.usage;
  if (isRecord(payload)) return payload;
  return null;
}

export type AnthropicUsageMetadata = {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  ephemeral5mInputTokens: number;
  ephemeral1hInputTokens: number;
  promptTokensIncludingCache: number;
};

export function extractAnthropicUsage(payload: unknown): NormalizedUsage {
  const usageRecord = resolveAnthropicUsageRecord(payload);
  if (!usageRecord) {
    return createEmptyNormalizedUsage();
  }

  const inputTokens = toPositiveInt(usageRecord.input_tokens ?? usageRecord.inputTokens);
  const outputTokens = toPositiveInt(usageRecord.output_tokens ?? usageRecord.outputTokens);
  const cacheReadTokens = Math.max(
    toPositiveInt(usageRecord.cache_read_input_tokens ?? usageRecord.cacheReadInputTokens),
    toPositiveInt(usageRecord.cached_tokens ?? usageRecord.cachedTokens),
  );
  const cacheCreationTokens = Math.max(
    toPositiveInt(usageRecord.cache_creation_input_tokens ?? usageRecord.cacheCreationInputTokens),
    toPositiveInt((usageRecord.cache_creation as AnthropicRecord | undefined)?.ephemeral_5m_input_tokens)
      + toPositiveInt((usageRecord.cache_creation as AnthropicRecord | undefined)?.ephemeral_1h_input_tokens),
    toPositiveInt((usageRecord.cacheCreation as AnthropicRecord | undefined)?.ephemeral5mInputTokens)
      + toPositiveInt((usageRecord.cacheCreation as AnthropicRecord | undefined)?.ephemeral1hInputTokens),
  );

  const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const completionTokens = outputTokens;
  const totalTokens = Math.max(
    toPositiveInt(usageRecord.total_tokens ?? usageRecord.totalTokens),
    promptTokens + completionTokens,
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens: cacheReadTokens,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    acceptedPredictionTokens: 0,
    rejectedPredictionTokens: 0,
  };
}

export function extractAnthropicUsageMetadata(payload: unknown): AnthropicUsageMetadata {
  const usageRecord = resolveAnthropicUsageRecord(payload);
  if (!usageRecord) {
    return {
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      ephemeral5mInputTokens: 0,
      ephemeral1hInputTokens: 0,
      promptTokensIncludingCache: 0,
    };
  }

  const inputTokens = toPositiveInt(usageRecord.input_tokens ?? usageRecord.inputTokens);
  const cacheReadInputTokens = Math.max(
    toPositiveInt(usageRecord.cache_read_input_tokens ?? usageRecord.cacheReadInputTokens),
    toPositiveInt(usageRecord.cached_tokens ?? usageRecord.cachedTokens),
  );
  const ephemeral5mInputTokens = Math.max(
    toPositiveInt((usageRecord.cache_creation as AnthropicRecord | undefined)?.ephemeral_5m_input_tokens),
    toPositiveInt((usageRecord.cacheCreation as AnthropicRecord | undefined)?.ephemeral5mInputTokens),
  );
  const ephemeral1hInputTokens = Math.max(
    toPositiveInt((usageRecord.cache_creation as AnthropicRecord | undefined)?.ephemeral_1h_input_tokens),
    toPositiveInt((usageRecord.cacheCreation as AnthropicRecord | undefined)?.ephemeral1hInputTokens),
  );
  const cacheCreationInputTokens = Math.max(
    toPositiveInt(usageRecord.cache_creation_input_tokens ?? usageRecord.cacheCreationInputTokens),
    ephemeral5mInputTokens + ephemeral1hInputTokens,
  );

  return {
    cacheReadInputTokens,
    cacheCreationInputTokens,
    ephemeral5mInputTokens,
    ephemeral1hInputTokens,
    promptTokensIncludingCache: inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
  };
}

export const anthropicMessagesUsage = {
  empty: createEmptyNormalizedUsage,
  fromPayload: extractAnthropicUsage,
  metadataFromPayload: extractAnthropicUsageMetadata,
  merge: mergeNormalizedUsage,
};
