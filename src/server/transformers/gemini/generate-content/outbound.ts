import {
  applyGeminiGenerateContentAggregate,
  createGeminiGenerateContentAggregateState,
  type GeminiGenerateContentAggregateState,
} from './aggregator.js';

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || '').replace(/\/+$/, '');
}

function baseIncludesVersion(baseUrl: string): boolean {
  return /\/v\d+(?:beta)?(?:\/|$)/i.test(baseUrl);
}

function resolveBaseUrl(baseUrl: string, apiVersion: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (baseIncludesVersion(normalized)) return normalized;
  return `${normalized}/${apiVersion}`;
}

function resolveModelsUrl(
  baseUrl: string,
  apiVersion: string,
  apiKey: string,
): string {
  const resolvedBaseUrl = resolveBaseUrl(baseUrl, apiVersion);
  const separator = resolvedBaseUrl.includes('?') ? '&' : '?';
  return `${resolvedBaseUrl}/models${separator}key=${encodeURIComponent(apiKey)}`;
}

function resolveActionUrl(
  baseUrl: string,
  apiVersion: string,
  modelActionPath: string,
  apiKey: string,
  search: string,
): string {
  const resolvedBaseUrl = resolveBaseUrl(baseUrl, apiVersion);
  const normalizedAction = modelActionPath.replace(/^\/+/, '');
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.set('key', apiKey);
  const query = params.toString();
  return `${resolvedBaseUrl}/${normalizedAction}${query ? `?${query}` : ''}`;
}

type GeminiRecord = Record<string, unknown>;

function isRecord(value: unknown): value is GeminiRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAggregateState(value: unknown): value is GeminiGenerateContentAggregateState {
  return isRecord(value) && Array.isArray(value.parts) && Array.isArray(value.groundingMetadata) && Array.isArray(value.citations);
}

function ensureAggregateState(payload: unknown): GeminiGenerateContentAggregateState {
  if (isAggregateState(payload)) return payload;

  const state = createGeminiGenerateContentAggregateState();
  const chunks = Array.isArray(payload) ? payload : [payload];
  for (const chunk of chunks) {
    applyGeminiGenerateContentAggregate(state, chunk);
  }
  return state;
}

function buildUsageMetadata(state: GeminiGenerateContentAggregateState): GeminiRecord | undefined {
  const usage = state.usage;
  const next: GeminiRecord = {};
  if (typeof usage.promptTokenCount === 'number') next.promptTokenCount = usage.promptTokenCount;
  if (typeof usage.candidatesTokenCount === 'number') next.candidatesTokenCount = usage.candidatesTokenCount;
  if (typeof usage.totalTokenCount === 'number') next.totalTokenCount = usage.totalTokenCount;
  if (typeof usage.cachedContentTokenCount === 'number') next.cachedContentTokenCount = usage.cachedContentTokenCount;
  if (typeof usage.thoughtsTokenCount === 'number') next.thoughtsTokenCount = usage.thoughtsTokenCount;
  return Object.keys(next).length > 0 ? next : undefined;
}

function buildCandidates(state: GeminiGenerateContentAggregateState): GeminiRecord[] {
  if (state.candidates.length > 0) {
    return state.candidates
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((candidate) => {
        const next: GeminiRecord = {
          index: candidate.index,
          finishReason: candidate.finishReason || 'STOP',
          content: {
            role: 'model',
            parts: candidate.parts,
          },
        };
        if (candidate.groundingMetadata) next.groundingMetadata = candidate.groundingMetadata;
        if (candidate.citationMetadata) next.citationMetadata = candidate.citationMetadata;
        return next;
      });
  }

  const fallback: GeminiRecord = {
    index: 0,
    finishReason: state.finishReason || 'STOP',
    content: {
      role: 'model',
      parts: state.parts,
    },
  };
  if (state.groundingMetadata.length > 0) {
    fallback.groundingMetadata = state.groundingMetadata[0];
  }
  if (state.citations.length > 0) {
    fallback.citationMetadata = state.citations[0];
  }
  return [fallback];
}

function extractRequestSemantics(requestPayload: unknown): GeminiRecord {
  if (!isRecord(requestPayload)) return {};

  const metadata: GeminiRecord = {};
  if (requestPayload.systemInstruction !== undefined) metadata.systemInstruction = requestPayload.systemInstruction;
  if (requestPayload.cachedContent !== undefined) metadata.cachedContent = requestPayload.cachedContent;

  const generationConfig = isRecord(requestPayload.generationConfig) ? requestPayload.generationConfig : null;
  if (generationConfig) {
    if (generationConfig.responseModalities !== undefined) metadata.responseModalities = generationConfig.responseModalities;
    if (generationConfig.responseSchema !== undefined) metadata.responseSchema = generationConfig.responseSchema;
    if (generationConfig.responseMimeType !== undefined) metadata.responseMimeType = generationConfig.responseMimeType;
  }

  if (Array.isArray(requestPayload.tools)) {
    const requestTools = requestPayload.tools
      .filter((item) => isRecord(item))
      .map((item) => {
        const next: GeminiRecord = {};
        if (item.googleSearch !== undefined) next.googleSearch = item.googleSearch;
        if (item.urlContext !== undefined) next.urlContext = item.urlContext;
        if (item.codeExecution !== undefined) next.codeExecution = item.codeExecution;
        if (item.functionDeclarations !== undefined) next.functionDeclarations = item.functionDeclarations;
        return next;
      })
      .filter((item) => Object.keys(item).length > 0);

    if (requestTools.length > 0) {
      metadata.tools = requestTools;
    }
  }

  return metadata;
}

export function serializeGeminiAggregateResponse(
  payload: GeminiGenerateContentAggregateState | unknown,
): GeminiRecord {
  const state = ensureAggregateState(payload);
  const response: GeminiRecord = {
    responseId: state.responseId || '',
    modelVersion: state.modelVersion || '',
    candidates: buildCandidates(state),
  };

  const usageMetadata = buildUsageMetadata(state);
  if (usageMetadata) {
    response.usageMetadata = usageMetadata;
  }

  return response;
}

export function extractResponseMetadata(payload: unknown, requestPayload?: unknown): GeminiRecord {
  const state = ensureAggregateState(payload);
  const metadata: GeminiRecord = extractRequestSemantics(requestPayload);

  if (state.citations.length > 0) metadata.citations = state.citations;
  if (state.groundingMetadata.length > 0) metadata.groundingMetadata = state.groundingMetadata;
  if (state.thoughtSignatures.length > 0) {
    metadata.thoughtSignature = state.thoughtSignatures[0];
    metadata.thoughtSignatures = state.thoughtSignatures;
  }
  const usageMetadata = buildUsageMetadata(state);
  if (usageMetadata) metadata.usageMetadata = usageMetadata;

  return metadata;
}

export const geminiGenerateContentOutbound = {
  resolveBaseUrl,
  resolveModelsUrl,
  resolveActionUrl,
  extractResponseMetadata,
  serializeAggregateResponse: serializeGeminiAggregateResponse,
};
