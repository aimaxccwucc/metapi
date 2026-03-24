import { describe, expect, it } from 'vitest';
import { buildAdminSessionClearCookie, buildAdminSessionCookie, extractClientIp, isIpAllowed } from './auth.js';

describe('auth middleware IP helpers', () => {
  it('extracts first forwarded IP only when trust proxy is enabled', () => {
    const ip = extractClientIp('::ffff:10.0.0.1', '198.51.100.7, 203.0.113.2', true);
    expect(ip).toBe('198.51.100.7');
  });

  it('falls back to remote address when trust proxy is disabled', () => {
    const ip = extractClientIp('::ffff:10.0.0.1', '198.51.100.7, 203.0.113.2', false);
    expect(ip).toBe('10.0.0.1');
  });

  it('allows request when allowlist is empty', () => {
    expect(isIpAllowed('203.0.113.8', [])).toBe(true);
  });

  it('rejects non-allowlisted IP when allowlist is configured', () => {
    expect(isIpAllowed('203.0.113.8', ['203.0.113.9'])).toBe(false);
    expect(isIpAllowed('203.0.113.9', ['203.0.113.9'])).toBe(true);
  });
});

describe('admin session cookie helpers', () => {
  it('builds httpOnly admin session cookies', () => {
    expect(buildAdminSessionCookie('admin-token-1')).toContain('metapi_admin_session=admin-token-1');
    expect(buildAdminSessionCookie('admin-token-1')).toContain('HttpOnly');
    expect(buildAdminSessionCookie('admin-token-1')).toContain('SameSite=Lax');
  });

  it('builds admin session clearing cookies', () => {
    expect(buildAdminSessionClearCookie()).toContain('metapi_admin_session=');
    expect(buildAdminSessionClearCookie()).toContain('Max-Age=0');
  });
});
