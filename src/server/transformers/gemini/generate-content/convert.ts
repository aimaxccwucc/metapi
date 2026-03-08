export type GeminiReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max';

type GeminiThinkingConfig = {
  thinkingBudget?: number;
  thinkingLevel?: string;
};

function normalizeReasoningEffort(value: unknown): GeminiReasoningEffort {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    normalized === 'none'
    || normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'max'
  ) {
    return normalized;
  }
  return 'medium';
}

function normalizeThinkingLevel(value: unknown): GeminiReasoningEffort | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'minimal') return 'low';
  if (
    normalized === 'none'
    || normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'max'
  ) {
    return normalized;
  }
  return null;
}

function thinkingBudgetToReasoningEffort(budget: number): GeminiReasoningEffort {
  if (budget <= 0) return 'none';
  if (budget <= 1024) return 'low';
  if (budget <= 8192) return 'medium';
  if (budget <= 32768) return 'high';
  return 'max';
}

function shouldUseThinkingLevel(model: string, effort: GeminiReasoningEffort): boolean {
  if (!/gemini-3-/i.test(model)) return false;
  return effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high';
}

function reasoningEffortToThinkingBudget(effort: GeminiReasoningEffort): number {
  switch (effort) {
    case 'none':
      return 0;
    case 'low':
      return 1024;
    case 'high':
      return 32768;
    case 'max':
      return 65536;
    case 'medium':
    default:
      return 8192;
  }
}

export function reasoningEffortToGeminiThinkingConfig(
  model: string,
  reasoningEffort: unknown,
): GeminiThinkingConfig {
  const effort = normalizeReasoningEffort(reasoningEffort);
  if (shouldUseThinkingLevel(model, effort)) {
    return { thinkingLevel: effort };
  }
  return { thinkingBudget: reasoningEffortToThinkingBudget(effort) };
}

export function geminiThinkingConfigToReasoning(
  thinkingConfig: Record<string, unknown> | null | undefined,
): { reasoningEffort: GeminiReasoningEffort; reasoningBudget: number } | null {
  if (!thinkingConfig || typeof thinkingConfig !== 'object') return null;

  const level = normalizeThinkingLevel(thinkingConfig.thinkingLevel);
  if (level) {
    return {
      reasoningEffort: level,
      reasoningBudget: reasoningEffortToThinkingBudget(level),
    };
  }

  const budget = typeof thinkingConfig.thinkingBudget === 'number' && Number.isFinite(thinkingConfig.thinkingBudget)
    ? Math.max(0, Math.trunc(thinkingConfig.thinkingBudget))
    : null;
  if (budget === null) return null;

  return {
    reasoningEffort: thinkingBudgetToReasoningEffort(budget),
    reasoningBudget: budget,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteInt(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.trunc(numeric));
}

export function resolveGeminiThinkingConfigFromRequest(
  model: string,
  body: Record<string, unknown>,
): GeminiThinkingConfig | null {
  const generationConfig = isRecord(body.generationConfig) ? body.generationConfig : null;
  const nativeThinkingConfig = isRecord(generationConfig?.thinkingConfig)
    ? generationConfig!.thinkingConfig as Record<string, unknown>
    : null;

  if (nativeThinkingConfig) {
    const nativeLevel = normalizeThinkingLevel(nativeThinkingConfig.thinkingLevel);
    const nativeBudget = toFiniteInt(nativeThinkingConfig.thinkingBudget);
    if (nativeLevel) {
      return { thinkingLevel: nativeLevel };
    }
    if (nativeBudget !== null) {
      return { thinkingBudget: nativeBudget };
    }
  }

  const reasoning = isRecord(body.reasoning) ? body.reasoning : null;
  const reasoningEffort = (
    typeof body.reasoning_effort === 'string' ? body.reasoning_effort
      : (typeof reasoning?.effort === 'string' ? reasoning.effort : undefined)
  );
  const reasoningBudget = (
    body.reasoning_budget
    ?? reasoning?.budget_tokens
    ?? reasoning?.thinkingBudget
    ?? reasoning?.max_tokens
  );

  const parsedBudget = toFiniteInt(reasoningBudget);
  if (parsedBudget !== null) {
    return reasoningEffortToGeminiThinkingConfig(model, thinkingBudgetToReasoningEffort(parsedBudget));
  }

  if (reasoningEffort !== undefined) {
    return reasoningEffortToGeminiThinkingConfig(model, reasoningEffort);
  }

  return null;
}

export function extractReasoningMetadataFromGeminiRequest(
  body: Record<string, unknown> | null | undefined,
): { reasoningEffort: GeminiReasoningEffort; reasoningBudget: number } | null {
  if (!body) return null;

  const generationConfig = isRecord(body.generationConfig) ? body.generationConfig : null;
  const thinkingConfig = isRecord(generationConfig?.thinkingConfig)
    ? generationConfig!.thinkingConfig as Record<string, unknown>
    : null;
  return geminiThinkingConfigToReasoning(thinkingConfig);
}
