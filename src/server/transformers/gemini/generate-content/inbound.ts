type GeminiRecord = Record<string, unknown>;
import { resolveGeminiThinkingConfigFromRequest } from './convert.js';

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

function cloneContents(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item) => isRecord(item))
    .map((item) => {
      const next: GeminiRecord = { ...item };
      if (Array.isArray(item.parts)) {
        next.parts = item.parts.map((part) => (isRecord(part) ? cloneJsonValue(part) : part));
      }
      return next;
    });
}

function cloneGenerationConfig(value: unknown): GeminiRecord | undefined {
  if (!isRecord(value)) return undefined;
  const allowedKeys = [
    'stopSequences',
    'responseModalities',
    'responseMimeType',
    'responseSchema',
    'candidateCount',
    'maxOutputTokens',
    'temperature',
    'topP',
    'topK',
    'presencePenalty',
    'frequencyPenalty',
    'seed',
    'responseLogprobs',
    'logprobs',
    'thinkingConfig',
    'imageConfig',
  ];
  const next: GeminiRecord = {};
  for (const key of allowedKeys) {
    if (value[key] !== undefined) next[key] = cloneJsonValue(value[key]);
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function cloneTools(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item) => isRecord(item))
    .map((item) => {
      const next: GeminiRecord = {};
      if (item.functionDeclarations !== undefined) next.functionDeclarations = cloneJsonValue(item.functionDeclarations);
      if (item.googleSearch !== undefined) next.googleSearch = cloneJsonValue(item.googleSearch);
      if (item.urlContext !== undefined) next.urlContext = cloneJsonValue(item.urlContext);
      if (item.codeExecution !== undefined) next.codeExecution = cloneJsonValue(item.codeExecution);
      return Object.keys(next).length > 0 ? next : cloneJsonValue(item);
    });
}

export type GeminiGenerateContentRequest = GeminiRecord;

export const geminiGenerateContentInbound = {
  normalizeRequest(body: unknown, modelName = ''): GeminiGenerateContentRequest {
    if (!isRecord(body)) return {};

    const next: GeminiGenerateContentRequest = {};
    if (body.contents !== undefined) next.contents = cloneContents(body.contents) ?? cloneJsonValue(body.contents);
    if (body.systemInstruction !== undefined) next.systemInstruction = cloneJsonValue(body.systemInstruction);
    if (body.cachedContent !== undefined) next.cachedContent = cloneJsonValue(body.cachedContent);
    if (body.safetySettings !== undefined) next.safetySettings = cloneJsonValue(body.safetySettings);
    if (body.generationConfig !== undefined) {
      next.generationConfig = cloneGenerationConfig(body.generationConfig) ?? cloneJsonValue(body.generationConfig);
    }
    if (body.tools !== undefined) next.tools = cloneTools(body.tools) ?? cloneJsonValue(body.tools);
    if (body.toolConfig !== undefined) next.toolConfig = cloneJsonValue(body.toolConfig);

    const derivedThinkingConfig = resolveGeminiThinkingConfigFromRequest(
      modelName || (typeof body.model === 'string' ? body.model : ''),
      body,
    );
    if (derivedThinkingConfig) {
      const generationConfig = isRecord(next.generationConfig)
        ? { ...next.generationConfig }
        : {};
      if (!isRecord(generationConfig.thinkingConfig)) {
        generationConfig.thinkingConfig = derivedThinkingConfig;
      }
      next.generationConfig = generationConfig;
    }

    const strippedKeys = new Set([
      'reasoning',
      'reasoning_effort',
      'reasoning_budget',
    ]);

    for (const [key, value] of Object.entries(body)) {
      if (strippedKeys.has(key)) continue;
      if (next[key] !== undefined) continue;
      next[key] = cloneJsonValue(value);
    }

    return next;
  },
};
