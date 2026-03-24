const OAUTH_CALLBACK_PREFIX = '/api/oauth/callback/';

export function isPublicApiRoute(url: string): boolean {
  return url.startsWith(OAUTH_CALLBACK_PREFIX);
}
