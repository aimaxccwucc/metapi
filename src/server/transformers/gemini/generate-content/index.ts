function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || '').replace(/\/+$/, '');
}

function baseIncludesVersion(baseUrl: string): boolean {
  return /\/v\d+(?:beta)?(?:\/|$)/i.test(baseUrl);
}

export function resolveGeminiNativeBaseUrl(baseUrl: string, apiVersion: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (baseIncludesVersion(normalized)) return normalized;
  return `${normalized}/${apiVersion}`;
}

export function resolveGeminiModelsUrl(
  baseUrl: string,
  apiVersion: string,
  apiKey: string,
): string {
  const base = resolveGeminiNativeBaseUrl(baseUrl, apiVersion);
  const separator = base.includes('?') ? '&' : '?';
  return `${base}/models${separator}key=${encodeURIComponent(apiKey)}`;
}

export function resolveGeminiGenerateContentUrl(
  baseUrl: string,
  apiVersion: string,
  modelActionPath: string,
  apiKey: string,
  search: string,
): string {
  const base = resolveGeminiNativeBaseUrl(baseUrl, apiVersion);
  const normalizedAction = modelActionPath.replace(/^\/+/, '');
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.set('key', apiKey);
  const query = params.toString();
  return `${base}/${normalizedAction}${query ? `?${query}` : ''}`;
}

import { geminiGenerateContentInbound } from './inbound.js';
import { geminiGenerateContentOutbound } from './outbound.js';
import { geminiGenerateContentStream } from './stream.js';
import { createGeminiGenerateContentAggregateState, applyGeminiGenerateContentAggregate } from './aggregator.js';
import { geminiGenerateContentUsage } from './usage.js';
import { reasoningEffortToGeminiThinkingConfig, geminiThinkingConfigToReasoning } from './convert.js';

export const geminiGenerateContentTransformer = {
  protocol: 'gemini/generate-content' as const,
  inbound: geminiGenerateContentInbound,
  outbound: geminiGenerateContentOutbound,
  stream: geminiGenerateContentStream,
  aggregator: {
    createState: createGeminiGenerateContentAggregateState,
    apply: applyGeminiGenerateContentAggregate,
  },
  usage: geminiGenerateContentUsage,
  convert: {
    reasoningEffortToGeminiThinkingConfig,
    geminiThinkingConfigToReasoning,
  },
  resolveBaseUrl: resolveGeminiNativeBaseUrl,
  resolveModelsUrl: resolveGeminiModelsUrl,
  resolveActionUrl: resolveGeminiGenerateContentUrl,
};

export {
  geminiGenerateContentInbound,
  geminiGenerateContentOutbound,
  geminiGenerateContentStream,
  createGeminiGenerateContentAggregateState,
  applyGeminiGenerateContentAggregate,
  geminiGenerateContentUsage,
  reasoningEffortToGeminiThinkingConfig,
  geminiThinkingConfigToReasoning,
};
