import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from 'node:zlib';
import {
  Response,
  fetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from 'undici';
import { config } from '../../config.js';

export type ProxyRuntimeRequest = {
  endpoint: 'chat' | 'messages' | 'responses';
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime?: {
    executor: 'default' | 'codex' | 'gemini-cli' | 'antigravity' | 'claude';
    modelName?: string;
    stream?: boolean;
    oauthProjectId?: string | null;
    action?: 'generateContent' | 'streamGenerateContent' | 'countTokens';
    timeoutMs?: number;
  };
};

export type RuntimeDispatchInput = {
  siteUrl: string;
  request: ProxyRuntimeRequest;
  targetUrl?: string;
  buildInit: (requestUrl: string, request: ProxyRuntimeRequest) => Promise<UndiciRequestInit> | UndiciRequestInit;
};

export type RuntimeResponse = UndiciResponse;

export type RuntimeExecutor = {
  dispatch(input: RuntimeDispatchInput): Promise<RuntimeResponse>;
};

type TimeoutWrappedSignal = {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
};

function mergeAbortSignals(
  originalSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): TimeoutWrappedSignal {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    timeoutController.abort(new Error(`upstream timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  const cleanupTimeout = () => clearTimeout(timeoutId);

  if (!originalSignal) {
    timeoutController.signal.addEventListener('abort', cleanupTimeout, { once: true });
    return {
      signal: timeoutController.signal,
      cleanup: cleanupTimeout,
      didTimeout: () => timedOut,
    };
  }

  if (originalSignal.aborted) {
    cleanupTimeout();
    return {
      signal: originalSignal,
      cleanup: cleanupTimeout,
      didTimeout: () => false,
    };
  }

  const combinedController = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    cleanupTimeout();
    combinedController.abort(signal.reason);
  };
  const onOriginalAbort = () => abortFrom(originalSignal);
  const onTimeoutAbort = () => abortFrom(timeoutController.signal);

  originalSignal.addEventListener('abort', onOriginalAbort, { once: true });
  timeoutController.signal.addEventListener('abort', onTimeoutAbort, { once: true });
  combinedController.signal.addEventListener('abort', () => {
    cleanupTimeout();
    originalSignal.removeEventListener('abort', onOriginalAbort);
    timeoutController.signal.removeEventListener('abort', onTimeoutAbort);
  }, { once: true });

  return {
    signal: combinedController.signal,
    cleanup: cleanupTimeout,
    didTimeout: () => timedOut,
  };
}

function resolveRuntimeRequestTimeoutMs(request: ProxyRuntimeRequest): number {
  const runtimeTimeoutMs = Math.trunc(request.runtime?.timeoutMs || 0);
  if (runtimeTimeoutMs > 0) {
    return Math.max(1_000, runtimeTimeoutMs);
  }
  if (request.runtime?.stream) {
    return config.upstreamStreamFirstByteTimeoutMs;
  }
  return config.upstreamRequestTimeoutMs;
}

export function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function withRequestBody(
  request: ProxyRuntimeRequest,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): ProxyRuntimeRequest {
  return {
    ...request,
    headers: headers ? { ...headers } : { ...request.headers },
    body,
  };
}

function buildUpstreamUrl(siteUrl: string, path: string): string {
  const normalizedBase = siteUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export async function performFetch(
  input: RuntimeDispatchInput,
  request: ProxyRuntimeRequest,
  requestUrl = input.targetUrl || buildUpstreamUrl(input.siteUrl, request.path),
): Promise<RuntimeResponse> {
  const init = await input.buildInit(requestUrl, request);
  const timeoutMs = resolveRuntimeRequestTimeoutMs(request);
  const timeoutSignal = mergeAbortSignals(init.signal ?? null, timeoutMs);
  try {
    return await fetch(requestUrl, {
      ...init,
      signal: timeoutSignal.signal,
    });
  } catch (error) {
    if (timeoutSignal.didTimeout()) {
      throw new Error(`upstream timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    timeoutSignal.cleanup();
  }
}

function hasZstdContentEncoding(contentEncoding: string | null): boolean {
  if (!contentEncoding) return false;
  return contentEncoding
    .split(',')
    .some((encoding) => encoding.trim().toLowerCase() === 'zstd');
}

function looksLikeZstdFrame(buffer: Buffer): boolean {
  return buffer.length >= 4
    && buffer[0] === 0x28
    && buffer[1] === 0xb5
    && buffer[2] === 0x2f
    && buffer[3] === 0xfd;
}

function decodeRuntimeResponseBuffer(buffer: Buffer, contentEncoding: string | null): Buffer {
  if (!contentEncoding) return buffer;

  let decoded = buffer;
  const encodings = contentEncoding
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean)
    .reverse();

  for (const encoding of encodings) {
    if (encoding === 'zstd') {
      decoded = zstdDecompressSync(decoded);
      continue;
    }
    if (encoding === 'br') {
      decoded = brotliDecompressSync(decoded);
      continue;
    }
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      decoded = gunzipSync(decoded);
      continue;
    }
    if (encoding === 'deflate') {
      decoded = inflateSync(decoded);
      continue;
    }
  }

  return decoded;
}

export async function readRuntimeResponseText(
  response: RuntimeResponse,
): Promise<string> {
  const contentEncoding = response.headers.get('content-encoding');
  if (!hasZstdContentEncoding(contentEncoding)) {
    return response.text().catch(() => '');
  }

  const rawBuffer = Buffer.from(await response.arrayBuffer());
  try {
    return decodeRuntimeResponseBuffer(rawBuffer, contentEncoding).toString('utf8');
  } catch {
    return looksLikeZstdFrame(rawBuffer) ? '' : rawBuffer.toString('utf8');
  }
}

export async function materializeErrorResponse(
  response: RuntimeResponse,
): Promise<RuntimeResponse> {
  if (response.ok) return response;
  const text = await readRuntimeResponseText(response);
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(text, {
    status: response.status,
    headers,
  });
}
