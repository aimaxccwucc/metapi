import { describe, expect, it } from 'vitest';

import { createResponsesProxyStreamSession } from './proxyStream.js';

describe('createResponsesProxyStreamSession', () => {
  it('gracefully finalizes native responses streams with meaningful output when the reader ends without a response.completed event', async () => {
    const lines: string[] = [];
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.4',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const chunks = [
      Buffer.from('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_truncated","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n'),
      Buffer.from('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_truncated","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n'),
      Buffer.from('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_truncated","delta":"partial"}\n\n'),
    ];
    let readIndex = 0;
    const result = await session.run({
      async read() {
        if (readIndex >= chunks.length) return { done: true };
        return { done: false, value: chunks[readIndex++] };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    }, {
      end() {},
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
      terminationReason: 'completed',
    });

    const output = lines.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('"output_text":"partial"');
    expect(output).toContain('data: [DONE]');
    expect(output).not.toContain('event: response.failed');
  });

  it('gracefully finalizes native responses streams with meaningful output when the reader errors before response.completed', async () => {
    const events: string[] = [];
    const lines: string[] = [];
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.4',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
        events.push(...nextLines);
      },
      writeRaw: (chunk) => {
        events.push(chunk);
      },
    });

    const chunks = [
      Buffer.from('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_reader_error","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n'),
      Buffer.from('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_reader_error","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n'),
      Buffer.from('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_reader_error","delta":"partial"}\n\n'),
    ];
    let readIndex = 0;
    const result = await session.run({
      async read() {
        if (readIndex < chunks.length) {
          return { done: false, value: chunks[readIndex++] };
        }
        throw new Error('socket hang up');
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    }, {
      end() {
        events.push('[end]');
      },
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
      terminationReason: 'completed',
    });

    const output = lines.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('"output_text":"partial"');
    expect(output).toContain('data: [DONE]');
    expect(output).not.toContain('event: response.failed');
    const completedIndex = events.findIndex((event) => event.includes('event: response.completed'));
    const doneIndex = events.findIndex((event) => event.includes('data: [DONE]'));
    const endIndex = events.indexOf('[end]');
    expect(completedIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(completedIndex);
    expect(endIndex).toBeGreaterThan(doneIndex);
  });

  it('serializes non-SSE fallback payloads into canonical responses SSE closeout events', () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const payload = {
      id: 'resp_fallback_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-5.2',
      output_text: 'hello from responses upstream',
      output: [
        {
          id: 'msg_fallback_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from responses upstream' }],
        },
      ],
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.2',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = session.consumeUpstreamFinalPayload(
      payload,
      JSON.stringify(payload),
      {
        end() {
          ended = true;
        },
      },
    );

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
      terminationReason: 'completed',
    });
    expect(ended).toBe(true);

    const output = lines.join('');
    expect(output).toContain('event: response.created');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('"type":"response.completed"');
    expect(output).toContain('"output_text":"hello from responses upstream"');
    expect(output).toContain('data: [DONE]');
  });
});
