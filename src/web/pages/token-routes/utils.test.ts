import { describe, expect, it } from 'vitest';

import {
  getModelPatternError,
  isExactModelPattern,
  matchesModelPattern,
  parseRegexModelPattern,
} from './utils.js';

describe('token route utils pattern parsing', () => {
  it('supports re: prefixed regex patterns', () => {
    expect(matchesModelPattern('claude-opus-4-6', 're:^claude-(opus|sonnet)-4-6$')).toBe(true);
    expect(matchesModelPattern('claude-haiku-4-6', 're:^claude-(opus|sonnet)-4-6$')).toBe(false);
  });

  it('supports slash-style and bare regex patterns', () => {
    expect(matchesModelPattern('KIMI-2-5', '/^kimi-(2|1\\.5)-5$/i')).toBe(true);
    expect(matchesModelPattern('moonshot-v1-32k', '^moonshot-v1-(8k|32k)$')).toBe(true);
    expect(parseRegexModelPattern('/^kimi-(2|1\\.5)-5$/i').regex).toBeInstanceOf(RegExp);
    expect(isExactModelPattern('/^kimi-(2|1\\.5)-5$/i')).toBe(false);
    expect(isExactModelPattern('^moonshot-v1-(8k|32k)$')).toBe(false);
  });

  it('still treats glob patterns as non-regex', () => {
    expect(matchesModelPattern('claude-opus-4-6', 'claude-*')).toBe(true);
    expect(parseRegexModelPattern('claude-*')).toEqual({ regex: null, error: null });
    expect(isExactModelPattern('claude-*')).toBe(false);
  });

  it('returns a validation error for invalid explicit regex', () => {
    expect(getModelPatternError('re:([a-z')).toContain('模型匹配正则错误');
  });
});
