import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
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
  useSystemProxy: boolean;
};

type ParsedSiteProxyInput = {
  present: boolean;
  valid: boolean;
  proxyUrl: string | null;
};

type SiteProxyConfigLike = {
  useSystemProxy?: boolean | null;
};

let siteProxyCache: {
  loadedAt: number;
  rows: SiteProxyRow[];
  systemProxyUrl: string | null;
} = {
  loadedAt: 0,
  rows: [],
  systemProxyUrl: null,
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

async function getCachedSiteProxyRows(nowMs = Date.now()): Promise<SiteProxyRow[]> {
  if ((nowMs - siteProxyCache.loadedAt) < SITE_PROXY_CACHE_TTL_MS) {
    return siteProxyCache.rows;
  }

  try {
    const [rows, systemProxySetting] = await Promise.all([
      db
        .select({
          siteUrl: schema.sites.url,
          useSystemProxy: schema.sites.useSystemProxy,
        })
        .from(schema.sites)
        .all(),
      db.select({ value: schema.settings.value })
        .from(schema.settings)
        .where(eq(schema.settings.key, 'system_proxy_url'))
        .get(),
    ]);
    const parsedSystemProxyUrl = normalizeSiteProxyUrl(
      typeof systemProxySetting?.value === 'string'
        ? (() => {
          try {
            return JSON.parse(systemProxySetting.value);
          } catch {
            return systemProxySetting.value;
          }
        })()
        : systemProxySetting?.value,
    );

    siteProxyCache = {
      loadedAt: nowMs,
      rows: rows.map((row) => ({
        siteUrl: normalizeSiteUrl(row.siteUrl),
        useSystemProxy: !!row.useSystemProxy,
      })),
      systemProxyUrl: parsedSystemProxyUrl,
    };
  } catch {
    siteProxyCache = { loadedAt: nowMs, rows: [], systemProxyUrl: null };
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
  siteProxyCache = { loadedAt: 0, rows: [], systemProxyUrl: null };
}

export async function resolveSiteProxyUrlByRequestUrl(requestUrl: string): Promise<string | null> {
  const normalizedRequestUrl = normalizeSiteUrl(requestUrl);
  if (!normalizedRequestUrl) return null;

  const rows = await getCachedSiteProxyRows();
  const systemProxyUrl = siteProxyCache.systemProxyUrl;
  if (!systemProxyUrl) return null;
  let bestMatch: string | null = null;
  let bestMatchLength = -1;

  for (const row of rows) {
    if (!row.useSystemProxy) continue;
    if (!row.siteUrl) continue;

    const isPrefixMatch = (
      normalizedRequestUrl === row.siteUrl
      || normalizedRequestUrl.startsWith(`${row.siteUrl}/`)
      || normalizedRequestUrl.startsWith(`${row.siteUrl}?`)
    );
    if (!isPrefixMatch) continue;

    if (row.siteUrl.length > bestMatchLength) {
      bestMatch = systemProxyUrl;
      bestMatchLength = row.siteUrl.length;
    }
  }

  return bestMatch;
}

export async function withSiteProxyRequestInit(
  requestUrl: string,
  options?: UndiciRequestInit,
): Promise<UndiciRequestInit> {
  const proxyUrl = (await resolveSiteProxyUrlByRequestUrl(requestUrl)) || resolveDefaultSiteProxyUrl();
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

export function resolveProxyUrlForSite(site: SiteProxyConfigLike | null | undefined): string | null {
  if (!site?.useSystemProxy) return null;
  return normalizeSiteProxyUrl(config.systemProxyUrl);
}

export function withSiteRecordProxyRequestInit(
  site: SiteProxyConfigLike | null | undefined,
  options?: UndiciRequestInit,
): UndiciRequestInit {
  return withExplicitProxyRequestInit(resolveProxyUrlForSite(site), options);
}
