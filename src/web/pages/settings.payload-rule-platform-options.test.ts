import { describe, expect, it } from 'vitest';
import { PAYLOAD_RULE_PROTOCOL_OPTIONS } from './settings/payloadRuleProtocolOptions.js';

describe('payload rule platform options', () => {
  it('includes upstream types supported by payload rule matching', () => {
    const values = PAYLOAD_RULE_PROTOCOL_OPTIONS.map((option) => option.value);

    expect(values).toEqual(expect.arrayContaining([
      '',
      'codex',
      'sub2api',
      'new-api',
      'one-api',
      'cliproxyapi',
      'openai',
      'claude',
      'gemini',
      'gemini-cli',
      'antigravity',
      'anyrouter',
      'done-hub',
      'one-hub',
      'veloera',
    ]));
  });
});
