import { describe, expect, it } from 'vitest';

import { createClaudeDownstreamContext } from '../../shared/normalized.js';
import { openAiChatTransformer } from './index.js';

function parseSsePayloads(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .filter((line) => line.startsWith('data: ') && line.trim() !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe('openAiChatTransformer.inbound', () => {
  it('captures chat request metadata fields without changing upstream body', () => {
    const result = openAiChatTransformer.transformRequest({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
      modalities: ['text', 'audio'],
      audio: { voice: 'alloy', format: 'mp3' },
      reasoning_effort: 'high',
      reasoning_budget: 1024,
      reasoning_summary: 'detailed',
      service_tier: 'priority',
      top_logprobs: 3,
      logit_bias: { '42': 5 },
      prompt_cache_key: 'cache-key',
      safety_identifier: 'safety-id',
      verbosity: 'low',
      response_format: { type: 'json_object' },
      stream_options: { include_usage: true },
    });

    expect(result.error).toBeUndefined();
    expect(result.value?.upstreamBody).toMatchObject({
      modalities: ['text', 'audio'],
      audio: { voice: 'alloy', format: 'mp3' },
      reasoning_effort: 'high',
      reasoning_budget: 1024,
      reasoning_summary: 'detailed',
      service_tier: 'priority',
      top_logprobs: 3,
      logit_bias: { '42': 5 },
      prompt_cache_key: 'cache-key',
      safety_identifier: 'safety-id',
      verbosity: 'low',
      response_format: { type: 'json_object' },
      stream_options: { include_usage: true },
    });
    expect((result.value as any)?.requestMetadata).toEqual({
      modalities: ['text', 'audio'],
      audio: { voice: 'alloy', format: 'mp3' },
      reasoningEffort: 'high',
      reasoningBudget: 1024,
      reasoningSummary: 'detailed',
      serviceTier: 'priority',
      topLogprobs: 3,
      logitBias: { '42': 5 },
      promptCacheKey: 'cache-key',
      safetyIdentifier: 'safety-id',
      verbosity: 'low',
      responseFormat: { type: 'json_object' },
      streamOptionsIncludeUsage: true,
    });
  });
});

describe('openAiChatTransformer.outbound', () => {
  it('carries annotations, citations, and detailed usage through final serialization', () => {
    const normalized = openAiChatTransformer.transformFinalResponse({
      id: 'chatcmpl-1',
      model: 'gpt-5',
      created: 123,
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'hello',
          reasoning_content: 'think',
          annotations: [
            { type: 'url_citation', url_citation: { url: 'https://a.example' } },
            { type: 'url_citation', url_citation: { url: 'https://a.example' } },
          ],
        },
      }],
      citations: ['https://c.example', 'https://c.example'],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    }, 'gpt-5');

    const payload = openAiChatTransformer.serializeFinalResponse(normalized, {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });

    const choice = (payload as any).choices[0];
    expect(choice.message.annotations).toEqual([
      { type: 'url_citation', url_citation: { url: 'https://a.example' } },
    ]);
    expect((payload as any).citations).toEqual(['https://c.example', 'https://a.example']);
    expect((payload as any).usage).toMatchObject({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
  });
});

describe('openAiChatTransformer.stream', () => {
  it('preserves annotations, citations, and usage payload on serialized stream chunks', () => {
    const context = openAiChatTransformer.createStreamContext('gpt-5');
    const event = openAiChatTransformer.transformStreamEvent({
      id: 'chatcmpl-1',
      model: 'gpt-5',
      choices: [{
        index: 0,
        finish_reason: null,
        delta: {
          role: 'assistant',
          content: 'hello',
          reasoning_content: 'why',
          annotations: [
            { type: 'url_citation', url_citation: { url: 'https://a.example' } },
          ],
        },
      }],
      citations: ['https://c.example', 'https://a.example'],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    }, context, 'gpt-5');

    const payloads = parseSsePayloads(
      openAiChatTransformer.serializeStreamEvent(event, context, createClaudeDownstreamContext()),
    );

    expect(payloads[0]).toMatchObject({
      citations: ['https://c.example', 'https://a.example'],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
    expect(((payloads[0] as any).choices[0] as any).delta.annotations).toEqual([
      { type: 'url_citation', url_citation: { url: 'https://a.example' } },
    ]);
  });
});

describe('openAiChatTransformer.aggregator', () => {
  it('deduplicates annotations/citations while aggregating reasoning, tool calls, and usage details', () => {
    const state = openAiChatTransformer.aggregator.createState();

    openAiChatTransformer.aggregator.applyEvent(state, {
      contentDelta: 'hel',
      reasoningDelta: 'why',
      toolCallDeltas: [{
        index: 0,
        id: 'call_1',
        name: 'search',
        argumentsDelta: '{"q":"cat"',
      }],
      annotations: [
        { type: 'url_citation', url_citation: { url: 'https://a.example' } },
      ],
      citations: ['https://c.example'],
      usageDetails: {
        prompt_tokens_details: { cached_tokens: 2 },
      },
    } as any);

    openAiChatTransformer.aggregator.applyEvent(state, {
      contentDelta: 'lo',
      reasoningDelta: ' now',
      toolCallDeltas: [{
        index: 0,
        id: 'call_1',
        name: 'search',
        argumentsDelta: ',"k":1}',
      }],
      annotations: [
        { type: 'url_citation', url_citation: { url: 'https://a.example' } },
        { type: 'url_citation', url_citation: { url: 'https://b.example' } },
      ],
      citations: ['https://c.example', 'https://d.example'],
      usageDetails: {
        completion_tokens_details: { reasoning_tokens: 4 },
      },
      finishReason: 'tool_calls',
    } as any);

    const normalized = openAiChatTransformer.aggregator.finalize(state, {
      id: 'chatcmpl-1',
      model: 'gpt-5',
      created: 123,
      content: '',
      reasoningContent: '',
      finishReason: 'stop',
      toolCalls: [],
    });

    expect(normalized).toMatchObject({
      content: 'hello',
      reasoningContent: 'why now',
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'call_1',
        name: 'search',
        arguments: '{"q":"cat","k":1}',
      }],
      citations: ['https://c.example', 'https://d.example'],
      usageDetails: {
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    });
    expect((normalized as any).annotations).toEqual([
      { type: 'url_citation', url_citation: { url: 'https://a.example' } },
      { type: 'url_citation', url_citation: { url: 'https://b.example' } },
    ]);
  });
});
