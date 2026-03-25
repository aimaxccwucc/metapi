import { describe, expect, it } from 'vitest';
import { isPublicApiRoute } from './publicApiRoutes.js';

describe('server public api routes', () => {
  it('marks login session route and oauth callbacks as public', () => {
    expect(isPublicApiRoute('/api/auth/session')).toBe(true);
    expect(isPublicApiRoute('/api/auth/session?next=%2F')).toBe(true);
    expect(isPublicApiRoute('/api/oauth/callback/codex')).toBe(true);
    expect(isPublicApiRoute('/api/oauth/callback/claude')).toBe(true);
    expect(isPublicApiRoute('/api/system/health')).toBe(false);
    expect(isPublicApiRoute('/api/stats/dashboard')).toBe(false);
  });
});
