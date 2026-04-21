import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { detectProxyFailure } from './proxyFailureJudge.js';

describe('detectProxyFailure (empty content)', () => {
  const originalEmptyFail = config.proxyEmptyContentFailEnabled;
  const originalKeywords = Array.isArray(config.proxyErrorKeywords) ? [...config.proxyErrorKeywords] : config.proxyErrorKeywords;

  afterEach(() => {
    config.proxyEmptyContentFailEnabled = originalEmptyFail;
    config.proxyErrorKeywords = originalKeywords as any;
  });

  it('flags empty assistant content even when total tokens > 0', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_empty',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 12, completionTokens: 0, totalTokens: 12 },
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('flags terminal chat completions with null assistant content even when completion tokens are non-zero', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_null_empty',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 21, completionTokens: 5, totalTokens: 26 },
    });

    expect(failure).toMatchObject({ status: 502, reason: 'Upstream returned empty content' });
  });

  it('flags completed responses payloads with no output content even when completion tokens are non-zero', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'resp_completed_empty',
      object: 'response',
      status: 'completed',
      model: 'gpt-5.4',
      usage: { input_tokens: 21, output_tokens: 5, total_tokens: 26 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 21, completionTokens: 5, totalTokens: 26 },
    });

    expect(failure).toMatchObject({ status: 502, reason: 'Upstream returned empty content' });
  });

  it('does not flag when output exists even if usage is missing', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_has_output',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hi' },
        finish_reason: 'stop',
      }],
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toBeNull();
  });

  it('flags terminal payloads with empty content when probe only gets a 200 shell', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_probe_empty',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toMatchObject({ status: 502, reason: 'Upstream returned empty content' });
  });

  it('does not treat tool call payloads as empty content', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'resp_tool',
      object: 'response',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_abc',
        name: 'Glob',
        arguments: '{"pattern":"README*"}',
      }],
      output_text: '',
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toBeNull();
  });

  it('does not treat anthropic tool_use responses as empty content', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'msg_tool_use',
      type: 'message',
      model: 'claude-sonnet-4.6',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'lookup_weather',
          input: { city: 'Shanghai' },
        },
      ],
      usage: { input_tokens: 12, output_tokens: 0 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 12, completionTokens: 0, totalTokens: 12 },
    });

    expect(failure).toBeNull();
  });

  it('does not treat anthropic thinking-only responses as empty content', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'msg_thinking',
      type: 'message',
      model: 'claude-sonnet-4.6',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'thinking',
          thinking: 'I should reason about this privately first.',
        },
      ],
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
    });

    expect(failure).toBeNull();
  });

  it('flags empty SSE streams that contain no content deltas', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = [
      'data: {"id":"evt_1","choices":[{"delta":{}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('treats DONE-only SSE as no output and flags failure', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = [
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('truncates fractional token counts before empty-content detection', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_fractional_empty',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 3.9, completion_tokens: 0.6, total_tokens: 4.5 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 3.9, completionTokens: 0.6, totalTokens: 4.5 } as any,
    });

    expect(failure).toMatchObject({ status: 502 });
  });
});
