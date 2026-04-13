import { config } from '../config.js';

export type FlaresolverrResult = {
  success: boolean;
  cookies: Record<string, string>;
  userAgent: string;
  message?: string;
};

type FlaresolverrRequestParams = {
  cmd: 'request.get' | 'request.post';
  url: string;
  userAgent?: string;
  proxy?: string;
  maxTimeout?: number;
};

const FLARESOLVERR_TIMEOUT_MS = 120_000;

/**
 * Convert a proxy URL so it is reachable from within a Docker container.
 * Replaces localhost/127.0.0.1 with host.docker.internal when metapi itself
 * runs in Docker (detected via config.flaresolverrUrl being a container hostname).
 */
function rewriteProxyForContainer(proxyUrl: string): string {
  if (!config.flaresolverrUrl) return proxyUrl;
  try {
    const url = new URL(proxyUrl);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = 'host.docker.internal';
      return url.toString();
    }
  } catch {}
  return proxyUrl;
}

export async function solveCfChallenge(
  flaresolverrUrl: string,
  targetUrl: string,
  options?: { userAgent?: string; proxyUrl?: string },
): Promise<FlaresolverrResult> {
  const baseUrl = flaresolverrUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/v1`;

  const params: FlaresolverrRequestParams = {
    cmd: 'request.get',
    url: targetUrl,
    maxTimeout: FLARESOLVERR_TIMEOUT_MS,
  };

  if (options?.userAgent) {
    params.userAgent = options.userAgent;
  }
  if (options?.proxyUrl) {
    params.proxy = rewriteProxyForContainer(options.proxyUrl);
  }

  const requestInit: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(FLARESOLVERR_TIMEOUT_MS + 10_000),
  };

  let responseText: string;
  let responseStatus: number;
  try {
    const { fetch } = await import('undici');
    // Do NOT proxy the request to FlareSolverr itself — it is an internal service.
    const resp = await fetch(endpoint, requestInit as any);
    responseStatus = resp.status;
    responseText = await resp.text();
  } catch (err: any) {
    return {
      success: false,
      cookies: {},
      userAgent: '',
      message: `FlareSolverr request failed: ${err?.message || err}`,
    };
  }

  let body: any;
  try {
    body = JSON.parse(responseText);
  } catch {
    return {
      success: false,
      cookies: {},
      userAgent: '',
      message: `FlareSolverr returned non-JSON (HTTP ${responseStatus})`,
    };
  }

  if (body.status !== 'ok') {
    return {
      success: false,
      cookies: {},
      userAgent: '',
      message: body.message || `FlareSolverr status: ${body.status}`,
    };
  }

  const solution = body.solution || {};
  const cookies: Record<string, string> = {};
  if (Array.isArray(solution.cookies)) {
    for (const c of solution.cookies) {
      if (c.name && c.value) {
        cookies[c.name] = c.value;
      }
    }
  }

  return {
    success: true,
    cookies,
    userAgent: solution.userAgent || '',
    message: solution.response ? undefined : 'No response in solution',
  };
}
