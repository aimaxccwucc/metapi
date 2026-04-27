import { describe, expect, it } from 'vitest';

import { createChatProxyStreamSession } from './proxyStream.js';

function createFailingReader(message: string) {
  return {
    async read() {
      throw new Error(message);
    },
    async cancel() {
      return undefined;
    },
    releaseLock() {},
  };
}
describe('createChatProxyStreamSession', () => {
  it('includes resolved usage when synthesizing a stream from a final payload', () => {
    const lines: string[] = [];
    let ended = false;
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5.4',
      successfulUpstreamPath: '/v1/chat/completions',
      getUsage: () => ({
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      }),
      writeLines(nextLines) {
        lines.push(...nextLines);
      },
      writeRaw(chunk) {
        lines.push(chunk);
      },
    });

    const result = session.consumeUpstreamFinalPayload({
      id: 'chatcmpl-final-json',
      object: 'chat.completion',
      created: 1706000000,
      model: 'gpt-5.4',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'hello',
        },
      }],
    }, '', {
      end() {
        ended = true;
      },
    });

    expect(result.status).toBe('completed');
    expect(ended).toBe(true);
    const payloads = lines
      .filter((line) => line.startsWith('data: ') && line.trim() !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    expect(payloads[payloads.length - 1]).toMatchObject({
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    });
  });

  it('marks upstream reader errors as upstream_error termination', async () => {
    const lines: string[] = [];
    let ended = false;
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5.4',
      successfulUpstreamPath: '/v1/responses',
      writeLines(nextLines) {
        lines.push(...nextLines);
      },
      writeRaw(chunk) {
        lines.push(chunk);
      },
    });

    const result = await session.run(createFailingReader('socket reset'), {
      end() {
        ended = true;
      },
    });

    expect(ended).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.terminationReason).toBe('upstream_error');
    expect(result.errorMessage).toContain('[stream:upstream_error]');
    expect(result.errorMessage).toContain('socket reset');
  });


  it('gracefully finalizes openai chat streams after reader errors when meaningful output was already sent', async () => {
    const events: string[] = [];
    const lines: string[] = [];
    const encoder = new TextEncoder();
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5.4',
      successfulUpstreamPath: '/v1/responses',
      writeLines(nextLines) {
        lines.push(...nextLines);
        events.push(...nextLines);
      },
      writeRaw(chunk) {
        lines.push(chunk);
        events.push(chunk);
      },
    });

    const chunks = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_reader_error_chat","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"hello"}\n\n',
    ].map((chunk) => encoder.encode(chunk));
    let readIndex = 0;
    const result = await session.run({
      async read() {
        if (readIndex < chunks.length) {
          return { done: false, value: chunks[readIndex++] };
        }
        throw new Error('socket reset');
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

    expect(result.status).toBe('completed');
    expect(result.terminationReason).toBe('completed');
    const output = lines.join('');
    const matches = output.match(/"content":"hello"/g) || [];
    expect(matches.length).toBe(1);
    expect(output).toContain('[DONE]');
    expect(output).not.toContain('response.failed');
    const doneIndex = events.findIndex((event) => event.includes('[DONE]'));
    const endIndex = events.indexOf('[end]');
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(doneIndex);
  });

  it('gracefully finalizes openai chat streams after trailing buffered data when meaningful output was already sent', async () => {
    const lines: string[] = [];
    const encoder = new TextEncoder();
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5.4',
      successfulUpstreamPath: '/v1/responses',
      writeLines(nextLines) {
        lines.push(...nextLines);
      },
      writeRaw(chunk) {
        lines.push(chunk);
      },
    });

    const chunks = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"hello"}\n',
    ].map((chunk) => encoder.encode(chunk));
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

    expect(result.status).toBe('completed');
    expect(result.terminationReason).toBe('completed');
    const output = lines.join('');
    const matches = output.match(/"content":"hello"/g) || [];
    expect(matches.length).toBe(1);
    expect(output).toContain('[DONE]');
    expect(output).not.toContain('response.failed');
  });


  it('does not fail empty visible chat streams when upstream reports completion usage', async () => {
    const lines: string[] = [];
    const encoder = new TextEncoder();
    let parsedUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5.5',
      successfulUpstreamPath: '/v1/chat/completions',
      getUsage: () => parsedUsage,
      onParsedPayload(payload) {
        if (!payload || typeof payload !== 'object') return;
        const usage = (payload as any).usage;
        if (!usage || typeof usage !== 'object') return;
        parsedUsage = {
          promptTokens: Number(usage.prompt_tokens || 0),
          completionTokens: Number(usage.completion_tokens || 0),
          totalTokens: Number(usage.total_tokens || 0),
        };
      },
      writeLines(nextLines) {
        lines.push(...nextLines);
      },
      writeRaw(chunk) {
        lines.push(chunk);
      },
    });

    const chunks = [
      'data: {"id":"chatcmpl_usage_only","object":"chat.completion.chunk","created":1706000000,"model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":146390,"completion_tokens":4,"total_tokens":146394}}\n\n',
      'data: [DONE]\n\n',
    ].map((chunk) => encoder.encode(chunk));
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

    expect(result.status).toBe('completed');
    expect(result.terminationReason).toBe('completed');
    const output = lines.join('');
    expect(output).toContain('[DONE]');
    expect(output).toContain('"completion_tokens":4');
    expect(output).not.toContain('response.failed');
    expect(output).not.toContain('Upstream returned empty content');
  });

  it('does not duplicate responses text when terminal done events replay full content', async () => {
    const lines: string[] = [];
    const encoder = new TextEncoder();
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-5.4',
      successfulUpstreamPath: '/v1/responses',
      writeLines(nextLines) {
        lines.push(...nextLines);
      },
      writeRaw(chunk) {
        lines.push(chunk);
      },
    });

    const chunks = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_text_once","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_text_once","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_text_once","delta":"hello"}\n\n',
      'event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"item_id":"msg_text_once","text":"hello"}\n\n',
      'event: response.content_part.done\ndata: {"type":"response.content_part.done","output_index":0,"item_id":"msg_text_once","content_index":0,"part":{"type":"output_text","text":"hello"}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_text_once","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hello"}]}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_text_once","model":"gpt-5.4","status":"completed","usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}\n\n',
      'data: [DONE]\n\n',
    ].map((chunk) => encoder.encode(chunk));

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

    expect(result.status).toBe('completed');

    const output = lines.join('');
    const matches = output.match(/"content":"hello"/g) || [];
    expect(matches.length).toBe(1);
  });
});
