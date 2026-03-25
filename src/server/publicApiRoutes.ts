const OAUTH_CALLBACK_PREFIX = '/api/oauth/callback/';
const PUBLIC_EXACT_ROUTES = new Set([
  '/api/auth/session',
]);

export function isPublicApiRoute(url: string): boolean {
  const path = String(url || '').split('?')[0] || '';
  if (PUBLIC_EXACT_ROUTES.has(path)) {
    return true;
  }
  return path.startsWith(OAUTH_CALLBACK_PREFIX);
}
