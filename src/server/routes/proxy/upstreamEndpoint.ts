import { fetchModelPricingCatalog } from '../../services/modelPricingService.js';
import type { DownstreamFormat } from '../../transformers/shared/normalized.js';
import {
  convertOpenAiBodyToResponsesBody as convertOpenAiBodyToResponsesBodyViaTransformer,
  sanitizeResponsesBodyForProxy as sanitizeResponsesBodyForProxyViaTransformer,
} from '../../transformers/openai/responses/conversion.js';
import {
  convertOpenAiBodyToAnthropicMessagesBody,
  sanitizeAnthropicMessagesBody,
} from '../../transformers/anthropic/messages/conversion.js';

export type UpstreamEndpoint = 'chat' | 'messages' | 'responses';
export type EndpointPreference = DownstreamFormat | 'responses';

type ChannelContext = {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatformName(platform: unknown): string {
  return asTrimmedString(platform).toLowerCase();
}

function isClaudeFamilyModel(modelName: string): boolean {
  const normalized = asTrimmedString(modelName).toLowerCase();
  if (!normalized) return false;
  return normalized === 'claude' || normalized.startsWith('claude-') || normalized.includes('claude');
}

function headerValueToString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const BLOCKED_PASSTHROUGH_HEADERS = new Set([
  'host',
  'content-type',
  'content-length',
  'accept-encoding',
  'cookie',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
]);

function shouldSkipPassthroughHeader(key: string): boolean {
  return HOP_BY_HOP_HEADERS.has(key) || BLOCKED_PASSTHROUGH_HEADERS.has(key);
}

function extractSafePassthroughHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) return {};

  const forwarded: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (!key || shouldSkipPassthroughHeader(key)) continue;

    const value = headerValueToString(rawValue);
    if (!value) continue;
    forwarded[key] = value;
  }

  return forwarded;
}

function extractClaudePassthroughHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) return {};

  const forwarded: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const shouldForward = (
      key.startsWith('anthropic-')
      || key.startsWith('x-claude-')
      || key.startsWith('x-stainless-')
    );
    if (!shouldForward) continue;

    const value = headerValueToString(rawValue);
    if (!value) continue;
    forwarded[key] = value;
  }

  return forwarded;
}

function extractResponsesPassthroughHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) return {};

  const forwarded: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const shouldForward = (
      key.startsWith('openai-')
      || key.startsWith('x-openai-')
      || key.startsWith('x-stainless-')
      || key.startsWith('chatgpt-')
      || key === 'originator'
    );
    if (!shouldForward) continue;

    const value = headerValueToString(rawValue);
    if (!value) continue;
    forwarded[key] = value;
  }

  return forwarded;
}

function ensureStreamAcceptHeader(
  headers: Record<string, string>,
  stream: boolean,
): Record<string, string> {
  if (!stream) return headers;

  const existingAccept = (
    headerValueToString(headers.accept)
    || headerValueToString((headers as Record<string, unknown>).Accept)
  );
  if (existingAccept) return headers;

  return {
    ...headers,
    accept: 'text/event-stream',
  };
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}


function normalizeEndpointTypes(value: unknown): UpstreamEndpoint[] {
  const raw = asTrimmedString(value).toLowerCase();
  if (!raw) return [];

  const normalized = new Set<UpstreamEndpoint>();

  if (
    raw.includes('/v1/messages')
    || raw === 'messages'
    || raw.includes('anthropic')
    || raw.includes('claude')
  ) {
    normalized.add('messages');
  }

  if (
    raw.includes('/v1/responses')
    || raw === 'responses'
    || raw.includes('response')
  ) {
    normalized.add('responses');
  }

  if (
    raw.includes('/v1/chat/completions')
    || raw.includes('chat/completions')
    || raw === 'chat'
    || raw === 'chat_completions'
    || raw === 'completions'
    || raw.includes('chat')
  ) {
    normalized.add('chat');
  }

  // Some upstreams return protocol families instead of concrete endpoint paths.
  if (raw === 'openai' || raw.includes('openai')) {
    normalized.add('chat');
    normalized.add('responses');
  }

  return Array.from(normalized);
}

function preferredEndpointOrder(
  downstreamFormat: EndpointPreference,
  sitePlatform?: string,
  preferMessagesForClaudeModel = false,
): UpstreamEndpoint[] {
  const platform = normalizePlatformName(sitePlatform);

  if (platform === 'gemini') {
    // Gemini upstream is routed through OpenAI-compatible chat endpoint.
    return ['chat'];
  }

  if (platform === 'openai') {
    if (preferMessagesForClaudeModel && downstreamFormat !== 'responses') {
      // Some OpenAI-compatible gateways expose Claude natively via /v1/messages.
      // Keep chat/responses as fallbacks when messages is unavailable.
      return ['messages', 'chat', 'responses'];
    }
    return downstreamFormat === 'responses'
      ? ['responses', 'chat', 'messages']
      : ['chat', 'responses', 'messages'];
  }

  if (platform === 'claude') {
    return ['messages'];
  }

  // Unknown/generic upstreams: prefer endpoint family that matches the
  // downstream API surface, then degrade progressively.
  if (downstreamFormat === 'responses') {
    if (preferMessagesForClaudeModel) {
      // Claude-family models on generic/new-api upstreams are commonly
      // messages-first even when downstream API is /v1/responses.
      return ['messages', 'chat', 'responses'];
    }
    return ['responses', 'chat', 'messages'];
  }

  if (downstreamFormat === 'claude') {
    return ['messages', 'chat', 'responses'];
  }

  if (downstreamFormat === 'openai' && preferMessagesForClaudeModel) {
    // Claude-family models are most stable with native Messages semantics.
    return ['messages', 'chat', 'responses'];
  }

  return ['chat', 'messages', 'responses'];
}

export async function resolveUpstreamEndpointCandidates(
  context: ChannelContext,
  modelName: string,
  downstreamFormat: EndpointPreference,
  requestedModelHint?: string,
): Promise<UpstreamEndpoint[]> {
  const sitePlatform = normalizePlatformName(context.site.platform);
  const preferMessagesForClaudeModel = (
    isClaudeFamilyModel(modelName)
    || isClaudeFamilyModel(asTrimmedString(requestedModelHint))
  );
  if (sitePlatform === 'anyrouter') {
    // anyrouter deployments are effectively anthropic-protocol first.
    if (downstreamFormat === 'responses') {
      return ['responses', 'messages', 'chat'];
    }
    return ['messages', 'chat', 'responses'];
  }

  const preferred = preferredEndpointOrder(
    downstreamFormat,
    context.site.platform,
    preferMessagesForClaudeModel,
  );
  const forceMessagesFirstForClaudeModel = (
    downstreamFormat === 'openai'
    && preferMessagesForClaudeModel
    && sitePlatform !== 'openai'
    && sitePlatform !== 'gemini'
  );

  try {
    const catalog = await fetchModelPricingCatalog({
      site: {
        id: context.site.id,
        url: context.site.url,
        platform: context.site.platform,
      },
      account: {
        id: context.account.id,
        accessToken: context.account.accessToken ?? null,
        apiToken: context.account.apiToken ?? null,
      },
      modelName,
      totalTokens: 0,
    });

    if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      return preferred;
    }

    const matched = catalog.models.find((item) =>
      asTrimmedString(item?.modelName).toLowerCase() === modelName.toLowerCase(),
    );
    if (!matched) return preferred;

    const shouldIgnoreCatalogOrderingForClaudeMessages = (
      preferMessagesForClaudeModel
      && (downstreamFormat !== 'responses' || sitePlatform !== 'openai')
    );
    if (shouldIgnoreCatalogOrderingForClaudeMessages) {
      return preferred;
    }

    const supportedRaw = Array.isArray(matched.supportedEndpointTypes) ? matched.supportedEndpointTypes : [];
    const normalizedSupportedRaw = supportedRaw
      .map((item) => asTrimmedString(item).toLowerCase())
      .filter((item) => item.length > 0);
    const hasConcreteEndpointHint = normalizedSupportedRaw.some((raw) => (
      raw.includes('/v1/messages')
      || raw.includes('/v1/chat/completions')
      || raw.includes('/v1/responses')
      || raw === 'messages'
      || raw === 'chat'
      || raw === 'chat_completions'
      || raw === 'completions'
      || raw === 'responses'
    ));
    if (forceMessagesFirstForClaudeModel && !hasConcreteEndpointHint) {
      // Generic labels like openai/anthropic are too coarse for Claude models;
      // keep messages-first order in this case.
      return preferred;
    }

    const supported = new Set<UpstreamEndpoint>();
    for (const endpoint of supportedRaw) {
      const normalizedList = normalizeEndpointTypes(endpoint);
      for (const normalized of normalizedList) {
        supported.add(normalized);
      }
    }

    if (supported.size === 0) return preferred;

    const firstSupported = preferred.find((endpoint) => supported.has(endpoint));
    if (!firstSupported) return preferred;

    // Catalog metadata can be incomplete/inaccurate, so only use it to pick
    // the first attempt. Keep downstream-driven fallback order unchanged.
    return [
      firstSupported,
      ...preferred.filter((endpoint) => endpoint !== firstSupported),
    ];
  } catch {
    return preferred;
  }
}

export function buildUpstreamEndpointRequest(input: {
  endpoint: UpstreamEndpoint;
  modelName: string;
  stream: boolean;
  tokenValue: string;
  sitePlatform?: string;
  siteUrl?: string;
  openaiBody: Record<string, unknown>;
  downstreamFormat: EndpointPreference;
  claudeOriginalBody?: Record<string, unknown>;
  responsesOriginalBody?: Record<string, unknown>;
  downstreamHeaders?: Record<string, unknown>;
}): {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const sitePlatform = normalizePlatformName(input.sitePlatform);
  const isClaudeUpstream = sitePlatform === 'claude';

  const resolveGeminiEndpointPath = (endpoint: UpstreamEndpoint): string => {
    const normalizedSiteUrl = asTrimmedString(input.siteUrl).toLowerCase();
    const openAiCompatBase = /\/openai(?:\/|$)/.test(normalizedSiteUrl);
    if (openAiCompatBase) {
      return endpoint === 'responses'
        ? '/responses'
        : '/chat/completions';
    }
    return endpoint === 'responses'
      ? '/v1beta/openai/responses'
      : '/v1beta/openai/chat/completions';
  };

  const resolveEndpointPath = (endpoint: UpstreamEndpoint): string => {
    if (sitePlatform === 'gemini') {
      return resolveGeminiEndpointPath(endpoint);
    }

    if (sitePlatform === 'openai') {
      if (endpoint === 'messages') return '/v1/messages';
      if (endpoint === 'responses') return '/v1/responses';
      return '/v1/chat/completions';
    }

    if (sitePlatform === 'claude') {
      return '/v1/messages';
    }

    if (endpoint === 'messages') return '/v1/messages';
    if (endpoint === 'responses') return '/v1/responses';
    return '/v1/chat/completions';
  };

  const passthroughHeaders = extractSafePassthroughHeaders(input.downstreamHeaders);
  const commonHeaders: Record<string, string> = {
    ...passthroughHeaders,
    'Content-Type': 'application/json',
  };
  if (!isClaudeUpstream) {
    commonHeaders.Authorization = `Bearer ${input.tokenValue}`;
  }

  if (input.endpoint === 'messages') {
    const claudeHeaders = input.downstreamFormat === 'claude'
      ? extractClaudePassthroughHeaders(input.downstreamHeaders)
      : {};
    const anthropicVersion = (
      claudeHeaders['anthropic-version']
      || passthroughHeaders['anthropic-version']
      || '2023-06-01'
    );
    const body = (
      input.downstreamFormat === 'claude' && input.claudeOriginalBody
        ? {
          ...input.claudeOriginalBody,
          model: input.modelName,
          stream: input.stream,
        }
        : convertOpenAiBodyToAnthropicMessagesBody(input.openaiBody, input.modelName, input.stream)
    );
    const sanitizedBody = sanitizeAnthropicMessagesBody(body);

    const headers = ensureStreamAcceptHeader({
      ...commonHeaders,
      ...claudeHeaders,
      'x-api-key': input.tokenValue,
      'anthropic-version': anthropicVersion,
    }, input.stream);

    return {
      path: resolveEndpointPath('messages'),
      headers,
      body: sanitizedBody,
    };
  }

  if (input.endpoint === 'responses') {
    const responsesHeaders = input.downstreamFormat === 'responses'
      ? extractResponsesPassthroughHeaders(input.downstreamHeaders)
      : {};
    const rawBody = (
      input.downstreamFormat === 'responses' && input.responsesOriginalBody
        ? {
          ...input.responsesOriginalBody,
          model: input.modelName,
          stream: input.stream,
        }
        : convertOpenAiBodyToResponsesBodyViaTransformer(input.openaiBody, input.modelName, input.stream)
    );
    const body = sanitizeResponsesBodyForProxyViaTransformer(rawBody, input.modelName, input.stream);

    const headers = ensureStreamAcceptHeader({
      ...commonHeaders,
      ...responsesHeaders,
    }, input.stream);

    return {
      path: resolveEndpointPath('responses'),
      headers,
      body,
    };
  }

  const headers = ensureStreamAcceptHeader(commonHeaders, input.stream);
  return {
    path: resolveEndpointPath('chat'),
    headers,
    body: {
      ...input.openaiBody,
      model: input.modelName,
      stream: input.stream,
    },
  };
}

function normalizeHeaderMap(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const value = headerValueToString(rawValue);
    if (!value) continue;
    normalized[key] = value;
  }
  return normalized;
}

export function buildMinimalJsonHeadersForCompatibility(input: {
  headers: Record<string, string>;
  endpoint: UpstreamEndpoint;
  stream: boolean;
}): Record<string, string> {
  const source = normalizeHeaderMap(input.headers);
  const minimal: Record<string, string> = {};

  if (source.authorization) minimal.authorization = source.authorization;
  if (source['x-api-key']) minimal['x-api-key'] = source['x-api-key'];

  if (input.endpoint === 'messages') {
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith('anthropic-')) continue;
      minimal[key] = value;
    }
    if (!minimal['anthropic-version']) {
      minimal['anthropic-version'] = '2023-06-01';
    }
  }

  minimal['content-type'] = 'application/json';
  minimal.accept = input.stream ? 'text/event-stream' : 'application/json';
  return minimal;
}

export function isUnsupportedMediaTypeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  if (status !== 400 && status !== 415) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return status === 415;

  return (
    text.includes('unsupported media type')
    || text.includes("only 'application/json' is allowed")
    || text.includes('only "application/json" is allowed')
    || text.includes('application/json')
    || text.includes('content-type')
  );
}

export function isEndpointDispatchDeniedError(status: number, upstreamErrorText?: string | null): boolean {
  if (status !== 403) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return false;

  return (
    /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i.test(upstreamErrorText || '')
    || text.includes('dispatch denied')
  );
}

export function shouldPreferResponsesAfterLegacyChatError(input: {
  status: number;
  upstreamErrorText?: string | null;
  downstreamFormat: EndpointPreference;
  sitePlatform?: string | null;
  modelName?: string | null;
  requestedModelHint?: string | null;
  currentEndpoint?: UpstreamEndpoint | null;
}): boolean {
  if (input.status < 400) return false;
  if (input.downstreamFormat !== 'openai') return false;
  if (input.currentEndpoint !== 'chat') return false;

  const sitePlatform = normalizePlatformName(input.sitePlatform);
  if (sitePlatform === 'openai' || sitePlatform === 'claude' || sitePlatform === 'gemini' || sitePlatform === 'anyrouter') {
    return false;
  }

  const modelName = asTrimmedString(input.modelName);
  const requestedModelHint = asTrimmedString(input.requestedModelHint);
  if (isClaudeFamilyModel(modelName) || isClaudeFamilyModel(requestedModelHint)) {
    return false;
  }

  const text = (input.upstreamErrorText || '').toLowerCase();
  return (
    text.includes('unsupported legacy protocol')
    && text.includes('/v1/chat/completions')
    && text.includes('/v1/responses')
  );
}

export function isEndpointDowngradeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (status === 404 || status === 405 || status === 415 || status === 501) return true;
  if (!text) return false;

  let parsedCode = '';
  let parsedType = '';
  let parsedMessage = '';
  try {
    const parsed = JSON.parse(upstreamErrorText || '{}') as Record<string, unknown>;
    const error = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : parsed;
    parsedCode = asTrimmedString(error.code).toLowerCase();
    parsedType = asTrimmedString(error.type).toLowerCase();
    parsedMessage = asTrimmedString(error.message).toLowerCase();
  } catch {
    parsedCode = '';
    parsedType = '';
    parsedMessage = '';
  }

  return (
    isEndpointDispatchDeniedError(status, upstreamErrorText)
    || 
    text.includes('convert_request_failed')
    || text.includes('not found')
    || text.includes('unknown endpoint')
    || text.includes('unsupported endpoint')
    || text.includes('unsupported path')
    || text.includes('unrecognized request url')
    || text.includes('no route matched')
    || text.includes('does not exist')
    || text.includes('openai_error')
    || text.includes('upstream_error')
    || text.includes('bad_response_status_code')
    || text.includes('unsupported media type')
    || text.includes("only 'application/json' is allowed")
    || text.includes('only "application/json" is allowed')
    || (status === 400 && text.includes('unsupported'))
    || text.includes('not implemented')
    || text.includes('api not implemented')
    || text.includes('unsupported legacy protocol')
    || parsedCode === 'convert_request_failed'
    || parsedCode === 'not_found'
    || parsedCode === 'endpoint_not_found'
    || parsedCode === 'unknown_endpoint'
    || parsedCode === 'unsupported_endpoint'
    || parsedCode === 'bad_response_status_code'
    || parsedCode === 'openai_error'
    || parsedCode === 'upstream_error'
    || parsedType === 'not_found_error'
    || parsedType === 'invalid_request_error'
    || parsedType === 'unsupported_endpoint'
    || parsedType === 'unsupported_path'
    || parsedType === 'bad_response_status_code'
    || parsedType === 'openai_error'
    || parsedType === 'upstream_error'
    || parsedMessage.includes('unknown endpoint')
    || parsedMessage.includes('unsupported endpoint')
    || parsedMessage.includes('unsupported path')
    || parsedMessage.includes('unrecognized request url')
    || parsedMessage.includes('no route matched')
    || parsedMessage.includes('does not exist')
    || parsedMessage.includes('bad_response_status_code')
    || parsedMessage === 'openai_error'
    || parsedMessage === 'upstream_error'
    || parsedMessage.includes('unsupported media type')
    || parsedMessage.includes("only 'application/json' is allowed")
    || parsedMessage.includes('only "application/json" is allowed')
    || (
      status === 400
      && parsedCode === 'invalid_request'
      && parsedType === 'new_api_error'
      && (parsedMessage.includes('claude code cli') || text.includes('claude code cli'))
    )
  );
}

