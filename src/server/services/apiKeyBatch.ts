import { normalizeApiKeyBatchInput } from './shared/apiKeyBatchCore.js';

export function parseApiKeyBatch(input: unknown): string[] {
  if (Array.isArray(input)) {
    const unique = new Set<string>();
    for (const item of input) {
      const normalized = typeof item === 'string' ? item.trim() : '';
      if (normalized) unique.add(normalized);
    }
    return [...unique];
  }
  if (typeof input === 'string') {
    return normalizeApiKeyBatchInput(input);
  }
  return [];
}
