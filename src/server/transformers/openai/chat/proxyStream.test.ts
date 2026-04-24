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
