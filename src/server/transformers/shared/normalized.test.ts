import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  fromTransformerMetadataRecord,
  normalizeStopReason,
  normalizeUpstreamFinalResponse,
  pullSseEventsWithDone,
  serializeFinalResponse,
  toTransformerMetadataRecord,
  type NormalizedFinalResponse,
  type TransformerMetadata,
} from './normalized.js';

describe('shared normalized helpers', () => {
  it('does not depend on route-level chatFormats helpers', () => {
    const source = readFileSync(new URL('./normalized.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('routes/proxy/chatFormats');
    expect(source).not.toContain('chatFormats.js');
  });

  it('exposes shared transformer metadata extensions', () => {
    const source = readFileSync(new URL('./normalized.ts', import.meta.url), 'utf8');
    expect(source).toContain('thoughtSignatures');
    expect(source).toContain('promptCacheKey');
    expect(source).toContain('truncation');
    expect(source).toContain('serviceTier');
  });

  it('parses SSE events and keeps the trailing partial block', () => {
    const pulled = pullSseEventsWithDone([
      'event: message',
      'data: {"id":"1"}',
      '',
      'data: [DONE]',
      '',
      'data: {"partial":true}',
    ].join('\n'));

    expect(pulled.events).toEqual([
      { event: 'message', data: '{"id":"1"}' },
      { event: '', data: '[DONE]' },
    ]);
    expect(pulled.rest).toBe('data: {"partial":true}');
  });

  it('normalizes responses payloads with tool calls', () => {
    expect(normalizeUpstreamFinalResponse({
      object: 'response',
      id: 'resp_1',
      model: 'gpt-test',
      created: 123,
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'hello' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"q":"x"}',
        },
      ],
      status: 'completed',
    }, 'fallback-model')).toEqual({
      id: 'resp_1',
      model: 'gpt-test',
      created: 123,
      content: 'hello',
      reasoningContent: '',
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      }],
    });
  });

  it('serializes normalized final responses for claude', () => {
    const normalized = {
      id: 'chatcmpl-1',
      model: 'claude-test',
      created: 456,
      content: 'done',
      reasoningContent: 'thinking',
      reasoningSignature: 'metapi:anthropic-signature:sig-1',
      redactedReasoningContent: 'ciphertext',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'tool_1', name: 'lookup', arguments: '{"q":"x"}' }],
    } as NormalizedFinalResponse & {
      reasoningSignature: string;
      redactedReasoningContent: string;
    };

    expect(serializeFinalResponse('claude', normalized, {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })).toEqual({
      id: 'msg_chatcmpl-1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [
        { type: 'thinking', thinking: 'thinking', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'ciphertext' },
        { type: 'text', text: 'done' },
        { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: 'x' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    });
  });

  it('serializes provider-tagged reasoning signatures for openai-compatible downstreams', () => {
    const normalized = {
      id: 'chatcmpl-2',
      model: 'gpt-test',
      created: 789,
      content: 'final',
      reasoningContent: 'deliberation',
      reasoningSignature: 'metapi:openai-encrypted-reasoning:enc-1',
      finishReason: 'stop',
      toolCalls: [],
    } as NormalizedFinalResponse & { reasoningSignature: string };

    expect(serializeFinalResponse('openai', normalized, {
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
    })).toMatchObject({
      choices: [{
        message: {
          role: 'assistant',
          content: 'final',
          reasoning_content: 'deliberation',
          reasoning_signature: 'metapi:openai-encrypted-reasoning:enc-1',
        },
      }],
    });
  });

  it('round-trips shared transformer metadata through transport-safe records', () => {
    const metadata: TransformerMetadata = {
      promptCacheKey: 'cache-key',
      truncation: 'auto',
      serviceTier: 'priority',
      citations: [{ uri: 'https://example.com/citation' }],
      thoughtSignature: 'sig-final',
      thoughtSignatures: ['sig-tool', 'sig-final'],
      geminiSafetySettings: [{ category: 'SAFE', threshold: 'BLOCK_NONE' }],
      geminiImageConfig: { aspectRatio: '16:9' },
      groundingMetadata: [{ webSearchQueries: ['cats'] }],
      usageMetadata: { totalTokenCount: 42 },
      passthrough: {
        cachedContent: 'cached/item-1',
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      },
    };

    expect(fromTransformerMetadataRecord(toTransformerMetadataRecord(metadata))).toEqual(metadata);
  });

  it('normalizes known stop reasons', () => {
    expect(normalizeStopReason('max_output_tokens')).toBe('length');
    expect(normalizeStopReason('tool_use')).toBe('tool_calls');
    expect(normalizeStopReason('completed')).toBe('stop');
    expect(normalizeStopReason('mystery')).toBeNull();
  });
});
