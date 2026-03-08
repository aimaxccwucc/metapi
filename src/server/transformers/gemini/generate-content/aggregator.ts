type GeminiRecord = Record<string, unknown>;

function isRecord(value: unknown): value is GeminiRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    ) as T;
  }
  return value;
}

function pushUniqueJson(target: GeminiRecord[], incoming: unknown): void {
  if (!isRecord(incoming)) return;
  const serialized = JSON.stringify(incoming);
  if (target.some((item) => JSON.stringify(item) === serialized)) return;
  target.push(cloneJsonValue(incoming));
}

function collectPartsFromPayload(payload: unknown): GeminiRecord[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => collectPartsFromPayload(item));
  }
  if (!isRecord(payload)) return [];

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const parts: GeminiRecord[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const content = isRecord(candidate.content) ? candidate.content : null;
    if (!content || !Array.isArray(content.parts)) continue;
    for (const part of content.parts) {
      if (isRecord(part)) parts.push(cloneJsonValue(part));
    }
  }
  return parts;
}

function updateIfDefined<T extends keyof GeminiGenerateContentUsageSummary>(
  usage: GeminiGenerateContentUsageSummary,
  key: T,
  value: unknown,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    usage[key] = value;
  }
}

export type GeminiGenerateContentUsageSummary = {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  totalTokenCount?: number | null;
  cachedContentTokenCount?: number | null;
  thoughtsTokenCount?: number | null;
};

export type GeminiGenerateContentCandidateAggregate = {
  index: number;
  finishReason: string | null;
  parts: GeminiRecord[];
  groundingMetadata?: GeminiRecord;
  citationMetadata?: GeminiRecord;
};

export type GeminiGenerateContentAggregateState = {
  responseId: string | null;
  modelVersion: string | null;
  finishReason: string | null;
  parts: GeminiRecord[];
  citations: GeminiRecord[];
  groundingMetadata: GeminiRecord[];
  thoughtSignatures: string[];
  usage: GeminiGenerateContentUsageSummary;
  candidates: GeminiGenerateContentCandidateAggregate[];
};

export function createGeminiGenerateContentAggregateState(): GeminiGenerateContentAggregateState {
  return {
    responseId: null,
    modelVersion: null,
    finishReason: null,
    parts: [],
    citations: [],
    groundingMetadata: [],
    thoughtSignatures: [],
    usage: {},
    candidates: [],
  };
}

function ensureCandidateAggregate(
  state: GeminiGenerateContentAggregateState,
  rawIndex: unknown,
): GeminiGenerateContentCandidateAggregate {
  const normalizedIndex = typeof rawIndex === 'number' && Number.isFinite(rawIndex)
    ? Math.max(0, Math.trunc(rawIndex))
    : 0;
  let existing = state.candidates.find((candidate) => candidate.index === normalizedIndex);
  if (!existing) {
    existing = {
      index: normalizedIndex,
      finishReason: null,
      parts: [],
    };
    state.candidates.push(existing);
    state.candidates.sort((left, right) => left.index - right.index);
  }
  return existing;
}

export function applyGeminiGenerateContentAggregate(
  state: GeminiGenerateContentAggregateState,
  payload: unknown,
): GeminiGenerateContentAggregateState {
  for (const part of collectPartsFromPayload(payload)) {
    state.parts.push(part);
    if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.trim()) {
      if (!state.thoughtSignatures.includes(part.thoughtSignature)) {
        state.thoughtSignatures.push(part.thoughtSignature);
      }
    }
  }

  const payloads = Array.isArray(payload) ? payload : [payload];
  for (const item of payloads) {
    if (!isRecord(item)) continue;

    if (typeof item.responseId === 'string' && item.responseId.trim()) {
      state.responseId = item.responseId.trim();
    }
    if (typeof item.modelVersion === 'string' && item.modelVersion.trim()) {
      state.modelVersion = item.modelVersion.trim();
    }

    const candidates = Array.isArray(item.candidates) ? item.candidates : [];
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      const candidateAggregate = ensureCandidateAggregate(state, candidate.index);
      if (candidate.groundingMetadata !== undefined) {
        pushUniqueJson(state.groundingMetadata, candidate.groundingMetadata);
        if (isRecord(candidate.groundingMetadata)) {
          candidateAggregate.groundingMetadata = cloneJsonValue(candidate.groundingMetadata);
        }
      }
      if (candidate.citationMetadata !== undefined) {
        pushUniqueJson(state.citations, candidate.citationMetadata);
        if (isRecord(candidate.citationMetadata)) {
          candidateAggregate.citationMetadata = cloneJsonValue(candidate.citationMetadata);
        }
      }
      if (typeof candidate.finishReason === 'string' && candidate.finishReason.trim()) {
        state.finishReason = candidate.finishReason.trim();
        candidateAggregate.finishReason = candidate.finishReason.trim();
      }

      const content = isRecord(candidate.content) ? candidate.content : null;
      if (content && Array.isArray(content.parts)) {
        for (const part of content.parts) {
          if (!isRecord(part)) continue;
          candidateAggregate.parts.push(cloneJsonValue(part));
        }
      }
    }

    const usageMetadata = isRecord(item.usageMetadata) ? item.usageMetadata : null;
    if (usageMetadata) {
      updateIfDefined(state.usage, 'promptTokenCount', usageMetadata.promptTokenCount);
      updateIfDefined(state.usage, 'candidatesTokenCount', usageMetadata.candidatesTokenCount);
      updateIfDefined(state.usage, 'totalTokenCount', usageMetadata.totalTokenCount);
      updateIfDefined(state.usage, 'cachedContentTokenCount', usageMetadata.cachedContentTokenCount);
      updateIfDefined(state.usage, 'thoughtsTokenCount', usageMetadata.thoughtsTokenCount);
    }
  }

  return state;
}
