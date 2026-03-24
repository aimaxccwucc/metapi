import { describe, expect, it } from 'vitest';
import { isPublicApiRoute } from './publicApiRoutes.js';

describe('server public api routes', () => {
  it('marks only oauth callbacks as public', () => {
    expect(isPublicApiRoute('/api/oauth/callback/codex')).toBe(true);
    expect(isPublicApiRoute('/api/oauth/callback/claude')).toBe(true);
    expect(isPublicApiRoute('/api/system/health')).toBe(false);
    expect(isPublicApiRoute('/api/stats/dashboard')).toBe(false);
  });
});
