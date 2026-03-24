import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { authorizeDownstreamToken, consumeManagedKeyRequest } from '../services/downstreamApiKeyService.js';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY, type DownstreamRoutingPolicy } from '../services/downstreamPolicyTypes.js';

const ADMIN_SESSION_COOKIE = 'metapi_admin_session';

export interface ProxyAuthContext {
  token: string;
  source: 'managed' | 'global';
  keyId: number | null;
  keyName: string;
  policy: DownstreamRoutingPolicy;
}

export interface ProxyResourceOwner {
  ownerType: 'managed_key' | 'global_proxy_token';
  ownerId: string;
}

const proxyAuthContextByRequest = new WeakMap<FastifyRequest, ProxyAuthContext>();

function normalizeIp(rawIp: string | null | undefined): string {
  const ip = (rawIp || '').trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length).trim();
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function resolveForwardedClientIp(xForwardedFor?: string | string[] | undefined): string {
  if (Array.isArray(xForwardedFor)) {
    const first = xForwardedFor.find((item) => item && item.trim().length > 0);
    if (first) return normalizeIp(first.split(',')[0]);
  } else if (typeof xForwardedFor === 'string' && xForwardedFor.trim().length > 0) {
    return normalizeIp(xForwardedFor.split(',')[0]);
  }
  return '';
}

export function extractClientIp(
  remoteIp: string | null | undefined,
  xForwardedFor?: string | string[] | undefined,
  trustProxy = config.trustProxy,
): string {
  if (trustProxy) {
    const forwardedIp = resolveForwardedClientIp(xForwardedFor);
    if (forwardedIp) return forwardedIp;
  }
  return normalizeIp(remoteIp);
}

function parseCookies(rawCookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!rawCookieHeader) return cookies;
  for (const part of rawCookieHeader.split(';')) {
    const entry = part.trim();
    if (!entry) continue;
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (!key) continue;
    cookies[key] = value;
  }
  return cookies;
}

function getAdminSessionCookie(request: FastifyRequest): string {
  const cookieHeader = typeof request.headers.cookie === 'string'
    ? request.headers.cookie
    : undefined;
  return parseCookies(cookieHeader)[ADMIN_SESSION_COOKIE] || '';
}

export function buildAdminSessionCookie(token: string, maxAgeSec = 12 * 60 * 60): string {
  const safeToken = encodeURIComponent((token || '').trim());
  return `${ADMIN_SESSION_COOKIE}=${safeToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.trunc(maxAgeSec))}`;
}

export function buildAdminSessionClearCookie(): string {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isIpAllowed(clientIp: string, allowlist: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const normalizedClientIp = normalizeIp(clientIp);
  if (!normalizedClientIp) return false;
  return allowlist.some((item) => normalizeIp(item) === normalizedClientIp);
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const clientIp = extractClientIp(request.ip, request.headers['x-forwarded-for']);
  if (!isIpAllowed(clientIp, config.adminIpAllowlist)) {
    reply.code(403).send({ error: 'IP not allowed' });
    return;
  }

  const auth = typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : '';
  const bearerToken = auth.startsWith('Bearer ')
    ? auth.replace('Bearer ', '').trim()
    : '';
  const token = bearerToken || getAdminSessionCookie(request);
  if (!token) {
    reply.code(401).send({ error: 'Missing admin session' });
    return;
  }
  if (token !== config.authToken) {
    reply.code(403).send({ error: 'Invalid token' });
    return;
  }
}

export async function proxyAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const auth = typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : '';
  const apiKeyHeader = typeof request.headers['x-api-key'] === 'string'
    ? request.headers['x-api-key']
    : '';
  const googApiKeyHeader = typeof request.headers['x-goog-api-key'] === 'string'
    ? request.headers['x-goog-api-key']
    : '';
  const queryKey = (
    request.query
    && typeof request.query === 'object'
    && typeof (request.query as Record<string, unknown>).key === 'string'
  )
    ? String((request.query as Record<string, unknown>).key).trim()
    : '';
  const token = auth
    ? auth.replace(/^Bearer\s+/i, '').trim()
    : (apiKeyHeader.trim() || googApiKeyHeader.trim() || queryKey);

  if (!token) {
    reply.code(401).send({ error: 'Missing Authorization, x-api-key, x-goog-api-key, or key query parameter' });
    return;
  }

  const authResult = await authorizeDownstreamToken(token);
  if (!authResult.ok) {
    reply.code(authResult.statusCode).send({ error: authResult.error });
    return;
  }

  if (authResult.source === 'managed' && authResult.key) {
    await consumeManagedKeyRequest(authResult.key.id);
  }

  proxyAuthContextByRequest.set(request, {
    token: authResult.token,
    source: authResult.source,
    keyId: authResult.key?.id ?? null,
    keyName: authResult.key?.name || 'global',
    policy: authResult.policy || EMPTY_DOWNSTREAM_ROUTING_POLICY,
  });
}

export function getProxyAuthContext(request: FastifyRequest): ProxyAuthContext | null {
  return proxyAuthContextByRequest.get(request) || null;
}

export function getProxyResourceOwner(request: FastifyRequest): ProxyResourceOwner | null {
  const auth = getProxyAuthContext(request);
  if (!auth) return null;

  if (auth.source === 'managed') {
    return {
      ownerType: 'managed_key',
      ownerId: auth.keyId === null ? auth.token : String(auth.keyId),
    };
  }

  return {
    ownerType: 'global_proxy_token',
    ownerId: 'global',
  };
}
