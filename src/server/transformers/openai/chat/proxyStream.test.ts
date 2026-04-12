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
});
