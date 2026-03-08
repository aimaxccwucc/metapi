import type {
  OpenAiChatNormalizedFinalResponse,
  OpenAiChatNormalizedStreamEvent,
  OpenAiChatRequestMetadata,
  OpenAiChatUsageDetails,
} from './model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (isRecord(item)) {
        const direct = typeof item.url === 'string'
          ? item.url
          : typeof item.uri === 'string'
            ? item.uri
            : '';
        return direct.trim();
      }
      return '';
    })
    .filter((item) => item.length > 0);
}

function toNumericRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .map(([key, raw]) => {
      const numeric = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(numeric)) return null;
      return [key, numeric] as const;
    })
    .filter((entry): entry is readonly [string, number] => !!entry);
  if (entries.length <= 0) return undefined;
  return Object.fromEntries(entries);
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableKey(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableKey(nested)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function annotationUrl(annotation: Record<string, unknown>): string {
  const urlCitation = asRecord(annotation.url_citation) ?? asRecord(annotation.urlCitation);
  const direct = typeof annotation.url === 'string' ? annotation.url : '';
  const nested = urlCitation && typeof urlCitation.url === 'string' ? urlCitation.url : '';
  return (direct || nested).trim();
}

export function dedupeAnnotations(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];

  for (const item of input) {
    if (!isRecord(item)) continue;
    const key = annotationUrl(item) || stableKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

export function dedupeCitations(input: unknown): string[] {
  const citations = new Set<string>();

  for (const citation of toStringArray(input)) {
    citations.add(citation);
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!isRecord(item)) continue;
      const nestedUrl = annotationUrl(item);
      if (nestedUrl) citations.add(nestedUrl);
    }
  }

  return Array.from(citations);
}

function extractAnnotationsFromPayload(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const collected: Array<Record<string, unknown>> = [];
  const append = (value: unknown) => {
    for (const item of dedupeAnnotations(value)) {
      collected.push(item);
    }
  };

  append(payload.annotations);

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    const choiceRecord = asRecord(choice);
    if (!choiceRecord) continue;
    append(asRecord(choiceRecord.message)?.annotations);
    append(asRecord(choiceRecord.delta)?.annotations);
  }

  return dedupeAnnotations(collected);
}

function extractCitationsFromPayload(
  payload: Record<string, unknown>,
  annotations: Array<Record<string, unknown>>,
): string[] {
  const citations = new Set<string>();

  for (const citation of dedupeCitations(payload.citations)) {
    citations.add(citation);
  }

  const transformerMetadata = asRecord(payload.transformer_metadata) ?? asRecord(payload.transformerMetadata);
  if (transformerMetadata) {
    for (const citation of dedupeCitations(transformerMetadata.citations)) {
      citations.add(citation);
    }
  }

  for (const annotation of annotations) {
    const url = annotationUrl(annotation);
    if (url) citations.add(url);
  }

  return Array.from(citations);
}

export function extractChatUsageDetails(payload: Record<string, unknown>): OpenAiChatUsageDetails | undefined {
  const usage = asRecord(payload.usage);
  if (!usage) return undefined;

  const promptDetails = toNumericRecord(usage.prompt_tokens_details ?? usage.promptTokensDetails);
  const completionDetails = toNumericRecord(usage.completion_tokens_details ?? usage.completionTokensDetails);
  if (!promptDetails && !completionDetails) return undefined;

  return {
    ...(promptDetails ? { prompt_tokens_details: promptDetails } : {}),
    ...(completionDetails ? { completion_tokens_details: completionDetails } : {}),
  };
}

export function mergeChatUsageDetails(
  base: OpenAiChatUsageDetails | undefined,
  next: OpenAiChatUsageDetails | undefined,
): OpenAiChatUsageDetails | undefined {
  if (!base && !next) return undefined;

  const mergeNumericMaps = (
    left: Record<string, number> | undefined,
    right: Record<string, number> | undefined,
  ): Record<string, number> | undefined => {
    if (!left && !right) return undefined;
    return Object.fromEntries(
      Array.from(new Set([...Object.keys(left || {}), ...Object.keys(right || {})]))
        .map((key) => [key, Math.max(left?.[key] || 0, right?.[key] || 0)]),
    );
  };

  return {
    ...(mergeNumericMaps(base?.prompt_tokens_details, next?.prompt_tokens_details)
      ? { prompt_tokens_details: mergeNumericMaps(base?.prompt_tokens_details, next?.prompt_tokens_details)! }
      : {}),
    ...(mergeNumericMaps(base?.completion_tokens_details, next?.completion_tokens_details)
      ? { completion_tokens_details: mergeNumericMaps(base?.completion_tokens_details, next?.completion_tokens_details)! }
      : {}),
  };
}

export function extractUsagePayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const usage = asRecord(payload.usage);
  if (!usage) return undefined;
  return usage;
}

export function extractChatResponseExtras(payload: unknown): Pick<
  OpenAiChatNormalizedFinalResponse,
  'annotations' | 'citations' | 'usageDetails' | 'usagePayload'
> & Pick<OpenAiChatNormalizedStreamEvent, 'annotations' | 'citations' | 'usageDetails' | 'usagePayload'> {
  const record = asRecord(payload);
  if (!record) return {};

  const annotations = extractAnnotationsFromPayload(record);
  const citations = extractCitationsFromPayload(record, annotations);
  const usageDetails = extractChatUsageDetails(record);
  const usagePayload = extractUsagePayload(record);

  return {
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(citations.length > 0 ? { citations } : {}),
    ...(usageDetails ? { usageDetails } : {}),
    ...(usagePayload ? { usagePayload } : {}),
  };
}

export function extractChatRequestMetadata(body: unknown): OpenAiChatRequestMetadata | undefined {
  const raw = asRecord(body);
  if (!raw) return undefined;

  const streamOptions = asRecord(raw.stream_options) ?? asRecord(raw.streamOptions);
  const metadata: OpenAiChatRequestMetadata = {
    ...(raw.modalities !== undefined ? { modalities: raw.modalities } : {}),
    ...(raw.audio !== undefined ? { audio: raw.audio } : {}),
    ...(raw.reasoning_effort !== undefined ? { reasoningEffort: raw.reasoning_effort } : {}),
    ...(raw.reasoning_budget !== undefined ? { reasoningBudget: raw.reasoning_budget } : {}),
    ...(raw.reasoning_summary !== undefined ? { reasoningSummary: raw.reasoning_summary } : {}),
    ...(raw.service_tier !== undefined ? { serviceTier: raw.service_tier } : {}),
    ...(raw.top_logprobs !== undefined ? { topLogprobs: raw.top_logprobs } : {}),
    ...(raw.logit_bias !== undefined ? { logitBias: raw.logit_bias } : {}),
    ...(raw.prompt_cache_key !== undefined ? { promptCacheKey: raw.prompt_cache_key } : {}),
    ...(raw.safety_identifier !== undefined ? { safetyIdentifier: raw.safety_identifier } : {}),
    ...(raw.verbosity !== undefined ? { verbosity: raw.verbosity } : {}),
    ...(raw.response_format !== undefined ? { responseFormat: raw.response_format } : {}),
    ...(streamOptions && streamOptions.include_usage !== undefined
      ? { streamOptionsIncludeUsage: Boolean(streamOptions.include_usage) }
      : {}),
  };

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
