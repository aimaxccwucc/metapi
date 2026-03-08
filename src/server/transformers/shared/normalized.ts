export {
  buildSyntheticOpenAiChunks,
  createClaudeDownstreamContext,
  createStreamTransformContext,
  normalizeStopReason,
  normalizeUpstreamFinalResponse,
  normalizeUpstreamStreamEvent,
  parseDownstreamChatRequest,
  pullSseEventsWithDone,
  serializeFinalResponse,
  serializeNormalizedStreamEvent,
  serializeStreamDone,
  toClaudeStopReason,
  type ClaudeDownstreamContext,
  type DownstreamFormat,
  type NormalizedFinalResponse,
  type NormalizedStreamEvent,
  type ParsedDownstreamChatRequest,
  type ParsedSseEvent,
  type StreamTransformContext,
} from './chatFormatsCore.js';

export type NormalizedContentBlockType =
  | 'text'
  | 'image_url'
  | 'image_inline'
  | 'input_audio'
  | 'output_audio'
  | 'tool_call'
  | 'tool_result'
  | 'function_response'
  | 'reasoning'
  | 'redacted_reasoning';

export type NormalizedContentBlock = {
  type: NormalizedContentBlockType;
  role?: string | null;
  text?: string | null;
  mimeType?: string | null;
  url?: string | null;
  data?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  argumentsText?: string | null;
  result?: unknown;
  metadata?: Record<string, unknown> | null;
};

export type NormalizedUsage = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  audioInputTokens?: number | null;
  audioOutputTokens?: number | null;
  acceptedPredictionTokens?: number | null;
  rejectedPredictionTokens?: number | null;
};

export type ParsedDownstreamChatRequestResult = {
  value?: import('./chatFormatsCore.js').ParsedDownstreamChatRequest;
  error?: { statusCode: number; payload: unknown };
};

export type TransformerMetadata = {
  include?: unknown;
  maxToolCalls?: number | null;
  promptCacheRetention?: unknown;
  includeObfuscation?: boolean | null;
  citations?: unknown;
  annotations?: unknown;
  geminiSafetySettings?: unknown;
  geminiImageConfig?: unknown;
  thoughtSignature?: string | null;
  passthrough?: Record<string, unknown>;
};

export type NormalizedRequest = {
  protocol: import('./chatFormatsCore.js').DownstreamFormat | 'responses' | 'gemini';
  model: string;
  stream: boolean;
  rawBody: unknown;
  parsed: import('./chatFormatsCore.js').ParsedDownstreamChatRequest | null;
  contentBlocks?: NormalizedContentBlock[];
  metadata?: TransformerMetadata;
};

export type NormalizedResponseEnvelope = {
  protocol: import('./chatFormatsCore.js').DownstreamFormat | 'responses' | 'gemini';
  model: string;
  final: import('./chatFormatsCore.js').NormalizedFinalResponse;
  usage?: unknown;
  contentBlocks?: NormalizedContentBlock[];
  metadata?: TransformerMetadata;
};

export type NormalizedStreamEnvelope = {
  protocol: import('./chatFormatsCore.js').DownstreamFormat | 'responses' | 'gemini';
  model: string;
  event: import('./chatFormatsCore.js').NormalizedStreamEvent;
  metadata?: TransformerMetadata;
};

export function createEmptyNormalizedUsage(): NormalizedUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    acceptedPredictionTokens: 0,
    rejectedPredictionTokens: 0,
  };
}

export function mergeNormalizedUsage(
  base: NormalizedUsage | undefined,
  next: NormalizedUsage | undefined,
): NormalizedUsage {
  const merged = { ...createEmptyNormalizedUsage(), ...(base || {}) };
  const incoming = next || {};
  return {
    promptTokens: (merged.promptTokens || 0) + (incoming.promptTokens || 0),
    completionTokens: (merged.completionTokens || 0) + (incoming.completionTokens || 0),
    totalTokens: (merged.totalTokens || 0) + (incoming.totalTokens || 0),
    cachedTokens: (merged.cachedTokens || 0) + (incoming.cachedTokens || 0),
    reasoningTokens: (merged.reasoningTokens || 0) + (incoming.reasoningTokens || 0),
    audioInputTokens: (merged.audioInputTokens || 0) + (incoming.audioInputTokens || 0),
    audioOutputTokens: (merged.audioOutputTokens || 0) + (incoming.audioOutputTokens || 0),
    acceptedPredictionTokens: (merged.acceptedPredictionTokens || 0) + (incoming.acceptedPredictionTokens || 0),
    rejectedPredictionTokens: (merged.rejectedPredictionTokens || 0) + (incoming.rejectedPredictionTokens || 0),
  };
}
