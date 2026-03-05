import { db, schema } from '../db/index.js';
import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';
import { ProxyAgent } from 'undici';

const SITE_PROXY_CACHE_TTL_MS = 3_000;
const SUPPORTED_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);

type SiteProxyRow = {
  siteUrl: string;
  proxyUrl: string | null;
};

type ParsedSiteProxyInput = {
  present: boolean;
  valid: boolean;
  proxyUrl: string | null;
};

let siteProxyCache: {
  loadedAt: number;
  rows: SiteProxyRow[];
} = {
  loadedAt: 0,
  rows: [],
};

const dispatcherCache = new Map<string, Dispatcher>();

function resolveDefaultSiteProxyUrl(): string | null {
  return normalizeSiteProxyUrl(process.env.DEFAULT_SITE_PROXY_URL);
}

function normalizeSiteUrl(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    const normalizedPath = pathname === '/' ? '' : pathname;
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function getCachedSiteProxyRows(nowMs = Date.now()): SiteProxyRow[] {
  if ((nowMs - siteProxyCache.loadedAt) < SITE_PROXY_CACHE_TTL_MS) {
    return siteProxyCache.rows;
  }

  try {
    const rows = db
      .select({
        siteUrl: schema.sites.url,
        proxyUrl: schema.sites.proxyUrl,
      })
      .from(schema.sites)
      .all();

    siteProxyCache = {
      loadedAt: nowMs,
      rows: rows.map((row) => ({
        siteUrl: normalizeSiteUrl(row.siteUrl),
        proxyUrl: normalizeSiteProxyUrl(row.proxyUrl),
      })),
    };
  } catch {
    siteProxyCache = { loadedAt: nowMs, rows: [] };
  }

  return siteProxyCache.rows;
}

function getDispatcherByProxyUrl(proxyUrl: string): Dispatcher | undefined {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return undefined;

  const cached = dispatcherCache.get(normalized);
  if (cached) return cached;

  try {
    const dispatcher = new ProxyAgent(normalized);
    dispatcherCache.set(normalized, dispatcher);
    return dispatcher;
  } catch {
    return undefined;
  }
}

export function normalizeSiteProxyUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return null;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function parseSiteProxyUrlInput(input: unknown): ParsedSiteProxyInput {
  if (input === undefined) {
    return { present: false, valid: true, proxyUrl: null };
  }
  if (input === null) {
    return { present: true, valid: true, proxyUrl: null };
  }

  if (typeof input !== 'string') {
    return { present: true, valid: false, proxyUrl: null };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { present: true, valid: true, proxyUrl: null };
  }

  const normalized = normalizeSiteProxyUrl(trimmed);
  if (!normalized) {
    return { present: true, valid: false, proxyUrl: null };
  }

  return {
    present: true,
    valid: true,
    proxyUrl: normalized,
  };
}

export function invalidateSiteProxyCache(): void {
  siteProxyCache = { loadedAt: 0, rows: [] };
}

export function resolveSiteProxyUrlByRequestUrl(requestUrl: string): string | null {
  const normalizedRequestUrl = normalizeSiteUrl(requestUrl);
  if (!normalizedRequestUrl) return null;

  const rows = getCachedSiteProxyRows();
  let bestMatch: string | null = null;
  let bestMatchLength = -1;

  for (const row of rows) {
    if (!row.proxyUrl) continue;
    if (!row.siteUrl) continue;

    const isPrefixMatch = (
      normalizedRequestUrl === row.siteUrl
      || normalizedRequestUrl.startsWith(`${row.siteUrl}/`)
      || normalizedRequestUrl.startsWith(`${row.siteUrl}?`)
    );
    if (!isPrefixMatch) continue;

    if (row.siteUrl.length > bestMatchLength) {
      bestMatch = row.proxyUrl;
      bestMatchLength = row.siteUrl.length;
    }
  }

  return bestMatch;
}

export function withSiteProxyRequestInit(
  requestUrl: string,
  options?: UndiciRequestInit,
): UndiciRequestInit {
  const proxyUrl = resolveSiteProxyUrlByRequestUrl(requestUrl) || resolveDefaultSiteProxyUrl();
  if (!proxyUrl) return options ?? {};

  const dispatcher = getDispatcherByProxyUrl(proxyUrl);
  if (!dispatcher) return options ?? {};

  return {
    ...(options || {}),
    dispatcher,
  };
}

export function withExplicitProxyRequestInit(
  proxyUrl: string | null | undefined,
  options?: UndiciRequestInit,
): UndiciRequestInit {
  const normalized = normalizeSiteProxyUrl(proxyUrl) || resolveDefaultSiteProxyUrl();
  if (!normalized) return options ?? {};

  const dispatcher = getDispatcherByProxyUrl(normalized);
  if (!dispatcher) return options ?? {};

  return {
    ...(options || {}),
    dispatcher,
  };
}
