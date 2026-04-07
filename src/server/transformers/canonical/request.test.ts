import { describe, expect, it } from 'vitest';

import { canonicalRequestFromOpenAiBody, createCanonicalRequestEnvelope } from './request.js';

describe('canonical request helpers', () => {
  it('normalizes a count_tokens request without provider-owned fields', () => {
    const request = createCanonicalRequestEnvelope({
      operation: 'count_tokens',
      surface: 'anthropic-messages',
      cliProfile: 'claude_code',
      requestedModel: ' claude-sonnet-4-5 ',
      stream: false,
      continuation: {
        sessionId: '  session-1  ',
        promptCacheKey: '  cache-1  ',
      },
    });

    expect(request).toEqual({
      operation: 'count_tokens',
      surface: 'anthropic-messages',
      cliProfile: 'claude_code',
      requestedModel: 'claude-sonnet-4-5',
      stream: false,
      messages: [],
      continuation: {
        sessionId: 'session-1',
        promptCacheKey: 'cache-1',
      },
    });
  });

  it('defaults generate requests to generic profile and empty collections', () => {
    const request = createCanonicalRequestEnvelope({
      requestedModel: 'gpt-5.2-codex',
      surface: 'openai-responses',
    });

    expect(request).toEqual({
      operation: 'generate',
      surface: 'openai-responses',
      cliProfile: 'generic',
      requestedModel: 'gpt-5.2-codex',
      stream: false,
      messages: [],
    });
  });

  it('sanitizes tool schemas when parsing OpenAI bodies into canonical requests', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5.2-codex',
        tools: [
          {
            type: 'function',
            function: {
              name: 'CronList',
              parameters: {
                type: 'object',
                properties: null,
                required: null,
                items: {
                  type: 'object',
                  required: ['cursor', null],
                },
              },
            },
          },
        ],
      },
      surface: 'openai-responses',
    });

    expect(request.tools).toEqual([
      {
        name: 'CronList',
        inputSchema: {
          type: 'object',
          properties: {},
          items: {
            type: 'object',
            properties: {},
            required: ['cursor'],
          },
        },
      },
    ]);
  });
});
