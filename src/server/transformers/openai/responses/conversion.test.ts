import { describe, expect, it } from 'vitest';

import {
  convertOpenAiBodyToResponsesBody,
  convertResponsesBodyToOpenAiBody,
  sanitizeResponsesBodyForProxy,
} from './conversion.js';

describe('sanitizeResponsesBodyForProxy', () => {
  it('preserves newer Responses request fields needed by the proxy', () => {
    const result = sanitizeResponsesBodyForProxy(
      {
        model: 'gpt-5',
        input: 'hello',
        safety_identifier: 'safe-user-1',
        max_tool_calls: 3,
        prompt_cache_key: 'cache-key',
        prompt_cache_retention: { scope: 'session' },
        stream_options: { include_obfuscation: true },
        background: true,
        text: { format: { type: 'text' }, verbosity: 'high' },
      },
      'gpt-5',
      true,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: true,
      safety_identifier: 'safe-user-1',
      max_tool_calls: 3,
      prompt_cache_key: 'cache-key',
      prompt_cache_retention: { scope: 'session' },
      stream_options: { include_obfuscation: true },
      background: true,
      text: { format: { type: 'text' }, verbosity: 'high' },
    });
  });
});

describe('convertOpenAiBodyToResponsesBody', () => {
  it('maps extra request fields and preserves custom/image_generation tools', () => {
    const result = convertOpenAiBodyToResponsesBody(
      {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'draw a cat' }],
        safety_identifier: 'safe-user-2',
        max_tool_calls: 2,
        prompt_cache_key: 'prompt-key',
        prompt_cache_retention: { scope: 'workspace' },
        stream_options: { include_obfuscation: true },
        background: false,
        verbosity: 'low',
        tools: [
          {
            type: 'custom',
            name: 'browser',
            description: 'browse the web',
            format: { type: 'text' },
          },
          {
            type: 'image_generation',
            background: 'transparent',
            size: '1024x1024',
          },
        ],
      },
      'gpt-5',
      false,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: false,
      safety_identifier: 'safe-user-2',
      max_tool_calls: 2,
      prompt_cache_key: 'prompt-key',
      prompt_cache_retention: { scope: 'workspace' },
      stream_options: { include_obfuscation: true },
      background: false,
      text: { verbosity: 'low' },
      tools: [
        {
          type: 'custom',
          name: 'browser',
          description: 'browse the web',
          format: { type: 'text' },
        },
        {
          type: 'image_generation',
          background: 'transparent',
          size: '1024x1024',
        },
      ],
    });
  });
});

describe('convertResponsesBodyToOpenAiBody', () => {
  it('preserves richer Responses request fields back onto the OpenAI-compatible body', () => {
    const result = convertResponsesBodyToOpenAiBody(
      {
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        safety_identifier: 'safe-user-3',
        max_tool_calls: 4,
        prompt_cache_key: 'prompt-key-2',
        prompt_cache_retention: { scope: 'project' },
        stream_options: { include_obfuscation: true },
        background: true,
        text: { format: { type: 'json_object' }, verbosity: 'high' },
        tools: [
          {
            type: 'custom',
            name: 'browser',
            format: { type: 'grammar', syntax: 'lark' },
          },
          {
            type: 'image_generation',
            background: 'transparent',
            partial_images: 2,
            output_format: 'png',
          },
        ],
      },
      'gpt-5',
      true,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: true,
      safety_identifier: 'safe-user-3',
      max_tool_calls: 4,
      prompt_cache_key: 'prompt-key-2',
      prompt_cache_retention: { scope: 'project' },
      stream_options: { include_obfuscation: true },
      background: true,
      verbosity: 'high',
      tools: [
        {
          type: 'custom',
          name: 'browser',
          format: { type: 'grammar', syntax: 'lark' },
        },
        {
          type: 'image_generation',
          background: 'transparent',
          partial_images: 2,
          output_format: 'png',
        },
      ],
    });
  });

  it('converts custom tool calls and outputs into OpenAI-compatible tool messages', () => {
    const result = convertResponsesBodyToOpenAiBody(
      {
        model: 'gpt-5',
        input: [
          {
            type: 'custom_tool_call',
            id: 'ct_1',
            call_id: 'ct_1',
            name: 'browser',
            input: 'open example.com',
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'ct_1',
            output: 'done',
          },
        ],
      },
      'gpt-5',
      false,
    );

    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'ct_1',
            type: 'function',
            function: {
              name: 'browser',
              arguments: 'open example.com',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'ct_1',
        content: 'done',
      },
    ]);
  });

  it('converts reasoning items back into assistant content instead of dropping them', () => {
    const result = convertResponsesBodyToOpenAiBody(
      {
        model: 'gpt-5',
        input: [
          {
            type: 'reasoning',
            id: 'rs_1',
            status: 'completed',
            summary: [
              { type: 'summary_text', text: 'Think step by step' },
            ],
          },
        ],
      },
      'gpt-5',
      false,
    );

    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Think step by step',
          },
        ],
      },
    ]);
  });

  it('preserves remaining request fields needed for OpenAI-compatible downstream fallback', () => {
    const result = convertResponsesBodyToOpenAiBody(
      {
        model: 'gpt-5',
        input: 'hello',
        user: 'user-123',
        include: ['reasoning.encrypted_content'],
        previous_response_id: 'resp_prev',
        truncation: 'auto',
        service_tier: 'priority',
        top_logprobs: 4,
      },
      'gpt-5',
      true,
    );

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: true,
      user: 'user-123',
      include: ['reasoning.encrypted_content'],
      previous_response_id: 'resp_prev',
      truncation: 'auto',
      service_tier: 'priority',
      top_logprobs: 4,
    });
  });
});
