import type {
  NormalizedFinalResponse,
  NormalizedStreamEvent,
  ParsedDownstreamChatRequest,
} from '../../shared/normalized.js';

export type OpenAiChatRequestMetadata = {
  modalities?: unknown;
  audio?: unknown;
  reasoningEffort?: unknown;
  reasoningBudget?: unknown;
  reasoningSummary?: unknown;
  serviceTier?: unknown;
  topLogprobs?: unknown;
  logitBias?: unknown;
  promptCacheKey?: unknown;
  safetyIdentifier?: unknown;
  verbosity?: unknown;
  responseFormat?: unknown;
  streamOptionsIncludeUsage?: boolean | null;
};

export type OpenAiChatUsageDetails = {
  prompt_tokens_details?: Record<string, number>;
  completion_tokens_details?: Record<string, number>;
};

export type OpenAiChatParsedRequest = ParsedDownstreamChatRequest & {
  requestMetadata?: OpenAiChatRequestMetadata;
};

export type OpenAiChatNormalizedFinalResponse = NormalizedFinalResponse & {
  annotations?: Array<Record<string, unknown>>;
  citations?: string[];
  usageDetails?: OpenAiChatUsageDetails;
  usagePayload?: Record<string, unknown>;
};

export type OpenAiChatNormalizedStreamEvent = NormalizedStreamEvent & {
  annotations?: Array<Record<string, unknown>>;
  citations?: string[];
  usageDetails?: OpenAiChatUsageDetails;
  usagePayload?: Record<string, unknown>;
};
