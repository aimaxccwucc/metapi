import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  rankConversationFileEndpoints,
  type ConversationFileInputSummary,
} from '../../proxy-core/capabilities/conversationFileCapabilities.js';
import { resolveProviderProfile } from '../../proxy-core/providers/registry.js';
import { config } from '../../config.js';
import { fetchModelPricingCatalog } from '../../services/modelPricingService.js';
import { applyPayloadRules } from '../../services/payloadRules.js';
import { applyManualSiteProtocolConfig } from '../../services/siteProtocolConfigService.js';
import {
  applyPersistedUpstreamEndpointPreference,
  recordPersistedUpstreamEndpointFailure,
  recordPersistedUpstreamEndpointSuccess,
  resetUpstreamProtocolProfileState,
} from '../../services/upstreamProtocolProfile.js';
import type { DownstreamFormat } from '../../transformers/shared/normalized.js';
import {
  convertOpenAiBodyToResponsesBody as convertOpenAiBodyToResponsesBodyViaTransformer,
  sanitizeResponsesBodyForProxy as sanitizeResponsesBodyForProxyViaTransformer,
} from '../../transformers/openai/responses/conversion.js';
import {
  convertOpenAiBodyToAnthropicMessagesBody,
  sanitizeAnthropicMessagesBody,
} from '../../transformers/anthropic/messages/conversion.js';
import {
  buildGeminiGenerateContentRequestFromOpenAi,
} from './geminiCliCompat.js';
import {
  buildMinimalJsonHeadersForCompatibility,
  hasExplicitEndpointCompatibilitySignal,
  isEndpointDispatchDeniedError,
  isEndpointDowngradeError,
  isUnsupportedMediaTypeError,
  promoteResponsesCandidateAfterLegacyChatError,
  shouldDowngradeMessagesEndpointAfterGenericBadResponseWrapper,
  shouldPreferResponsesAfterLegacyChatError,
} from '../../transformers/shared/endpointCompatibility.js';
import {
  sanitizeJsonSchemaForFunctionTool,
  sanitizeOpenAiResponseFormat,
} from '../../transformers/shared/jsonSchema.js';
export {
  buildMinimalJsonHeadersForCompatibility,
  hasExplicitEndpointCompatibilitySignal,
  isEndpointDispatchDeniedError,
  isEndpointDowngradeError,
  isUnsupportedMediaTypeError,
  promoteResponsesCandidateAfterLegacyChatError,
  shouldDowngradeMessagesEndpointAfterGenericBadResponseWrapper,
  shouldPreferResponsesAfterLegacyChatError,
};

export type UpstreamEndpoint = 'chat' | 'messages' | 'responses';
export type EndpointPreference = DownstreamFormat | 'responses';

type EndpointCapabilityProfile = {
  preferMessagesForClaudeModel: boolean;
  hasImageInput: boolean;
  hasAudioInput: boolean;
  hasNonImageFileInput: boolean;
  hasRemoteDocumentUrl: boolean;
  wantsNativeResponsesReasoning: boolean;
};

type EndpointRuntimeState = {
  preferredEndpoint: UpstreamEndpoint | null;
  preferredUpdatedAtMs: number;
  preferredReason: 'success' | 'suggested' | null;
  blockedUntilMsByEndpoint: Partial<Record<UpstreamEndpoint, number>>;
  probeAfterMs: number | null;
  lastProbeAtMs: number | null;
  lastProbeStatus: 'success' | 'failed' | null;
};

export type UpstreamEndpointRuntimeMemoryEntry = {
  key: string;
  preferredEndpoint: UpstreamEndpoint | null;
  preferredUpdatedAtMs: number;
  preferredReason: 'success' | 'suggested' | null;
  blockedUntilMsByEndpoint: Partial<Record<UpstreamEndpoint, number>>;
  activeBlocks: UpstreamEndpoint[];
  hasFreshPreference: boolean;
  probeAfterMs: number | null;
  probeReady: boolean;
  lastProbeAtMs: number | null;
  lastProbeStatus: 'success' | 'failed' | null;
};

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

type EndpointMemoryCredentialScope = {
  siteId: number;
  accountId: number | null;
  credentialSource: 'account_api_token' | 'account_access_token' | 'site_api_key' | 'none';
  credentialFingerprint: string | null;
};

export type EndpointMemoryCredentialScopeEntry = EndpointMemoryCredentialScope & {
  cacheKey: string;
};

const ENDPOINT_RUNTIME_PREFERRED_TTL_MS = 24 * 60 * 60 * 1000;
const ENDPOINT_RUNTIME_BLOCK_TTL_MS = 6 * 60 * 60 * 1000;
const ENDPOINT_MEMORY_SCOPE_MAX_ENTRIES = 2048;
const endpointRuntimeStates = new Map<string, EndpointRuntimeState>();
const endpointMemoryScopeStorage = new AsyncLocalStorage<EndpointMemoryCredentialScope>();
const endpointMemoryScopeBySiteAndToken = new Map<string, EndpointMemoryCredentialScope>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveRequestedModelForPayloadRules(input: {
  modelName: string;
  openaiBody: Record<string, unknown>;
  claudeOriginalBody?: Record<string, unknown>;
  responsesOriginalBody?: Record<string, unknown>;
}): string {
  return (
    asTrimmedString(input.responsesOriginalBody?.model)
    || asTrimmedString(input.claudeOriginalBody?.model)
    || asTrimmedString(input.openaiBody.model)
    || asTrimmedString(input.modelName)
  );
}

function normalizePlatformName(platform: unknown): string {
  return asTrimmedString(platform).toLowerCase();
}

function normalizeEndpointRuntimeModelScope(modelName: unknown): string {
  const normalized = asTrimmedString(modelName).toLowerCase();
  if (!normalized) return 'model:any';
  return `model:${normalized.slice(0, 120)}`;
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

const CODEX_CLIENT_VERSION = '0.101.0';
const CODEX_DEFAULT_USER_AGENT = 'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';
const ANTIGRAVITY_RUNTIME_USER_AGENT = 'antigravity/1.19.6 darwin/arm64';
const CLAUDE_DEFAULT_USER_AGENT = 'claude-cli/2.1.63 (external, cli)';
const CLAUDE_DEFAULT_BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05';

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

function getInputHeader(
  headers: Record<string, unknown> | Record<string, string> | undefined,
  key: string,
): string | null {
  if (!headers) return null;
  for (const [candidateKey, candidateValue] of Object.entries(headers)) {
    if (candidateKey.toLowerCase() !== key.toLowerCase()) continue;
    return headerValueToString(candidateValue);
  }
  return null;
}

function parseGeminiCliUserAgentRuntime(userAgent: string | null): {
  version: string;
  platform: string;
  arch: string;
} | null {
  if (!userAgent) return null;
  const match = /^GeminiCLI\/([^/]+)\/[^ ]+ \(([^;]+); ([^)]+)\)$/i.exec(userAgent.trim());
  if (!match) return null;
  return {
    version: match[1] || '0.31.0',
    platform: match[2] || 'win32',
    arch: match[3] || 'x64',
  };
}

function buildGeminiCLIUserAgent(modelName: string, existingUserAgent?: string | null): string {
  const parsed = parseGeminiCliUserAgentRuntime(existingUserAgent ?? null);
  const version = parsed?.version || '0.31.0';
  const platform = parsed?.platform || 'win32';
  const arch = parsed?.arch || 'x64';
  const effectiveModel = asTrimmedString(modelName) || 'unknown';
  return `GeminiCLI/${version}/${effectiveModel} (${platform}; ${arch})`;
}

function uuidFromSeed(seed: string): string {
  const hash = createHash('sha1').update(seed).digest();
  const bytes = new Uint8Array(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function mergeClaudeBetaHeader(
  explicitValue: string | null,
  extraBetas: string[] = [],
): string {
  const source = explicitValue || CLAUDE_DEFAULT_BETA_HEADER;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of source.split(',')) {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }
  if (!explicitValue) {
    for (const entry of extraBetas) {
      const normalized = entry.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged.join(',');
}

function extractClaudeBetasFromBody(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  betas: string[];
} {
  const next = { ...body };
  const rawBetas = next.betas;
  delete next.betas;

  if (typeof rawBetas === 'string') {
    return {
      body: next,
      betas: rawBetas.split(',').map((entry) => entry.trim()).filter(Boolean),
    };
  }

  if (Array.isArray(rawBetas)) {
    return {
      body: next,
      betas: rawBetas
        .map((entry) => asTrimmedString(entry))
        .filter(Boolean),
    };
  }

  return {
    body: next,
    betas: [],
  };
}

function buildCodexRuntimeHeaders(input: {
  baseHeaders: Record<string, string>;
  providerHeaders?: Record<string, string>;
  explicitSessionId?: string | null;
  continuityKey?: string | null;
}): Record<string, string> {
  const authorization = (
    getInputHeader(input.baseHeaders, 'authorization')
    || getInputHeader(input.baseHeaders, 'Authorization')
    || ''
  );
  const originator = getInputHeader(input.providerHeaders, 'originator') || 'codex_cli_rs';
  const accountId = getInputHeader(input.providerHeaders, 'chatgpt-account-id');
  const version = getInputHeader(input.baseHeaders, 'version') || CODEX_CLIENT_VERSION;
  const userAgent = getInputHeader(input.baseHeaders, 'user-agent') || CODEX_DEFAULT_USER_AGENT;
  const explicitSessionId = asTrimmedString(input.explicitSessionId);
  const continuityKey = asTrimmedString(input.continuityKey);
  const sessionId = (
    getInputHeader(input.baseHeaders, 'session_id')
    || getInputHeader(input.baseHeaders, 'session-id')
    || explicitSessionId
    || (continuityKey ? uuidFromSeed(`metapi:codex:${continuityKey}`) : null)
    || randomUUID()
  );
  const conversationId = (
    getInputHeader(input.baseHeaders, 'conversation_id')
    || getInputHeader(input.baseHeaders, 'conversation-id')
    || explicitSessionId
    || (continuityKey ? sessionId : null)
  );

  return {
    Authorization: authorization,
    'Content-Type': 'application/json',
    ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
    Originator: originator,
    Version: version,
    Session_id: sessionId,
    ...(conversationId ? { Conversation_id: conversationId } : {}),
    'User-Agent': userAgent,
    Accept: 'text/event-stream',
    Connection: 'Keep-Alive',
  };
}

function buildGeminiCliRuntimeHeaders(input: {
  baseHeaders: Record<string, string>;
  providerHeaders?: Record<string, string>;
  modelName: string;
  stream: boolean;
}): Record<string, string> {
  const apiClient = (
    getInputHeader(input.providerHeaders, 'x-goog-api-client')
    || getInputHeader(input.baseHeaders, 'x-goog-api-client')
  );
  const userAgent = buildGeminiCLIUserAgent(
    input.modelName,
    getInputHeader(input.providerHeaders, 'user-agent') || getInputHeader(input.baseHeaders, 'user-agent'),
  );

  const headers: Record<string, string> = {
    Authorization: input.baseHeaders.Authorization,
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
  };
  if (apiClient) {
    headers['X-Goog-Api-Client'] = apiClient;
  }
  if (input.stream) {
    headers.Accept = 'text/event-stream';
  }
  return headers;
}

function buildAntigravityRuntimeHeaders(input: {
  baseHeaders: Record<string, string>;
  stream: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: input.baseHeaders.Authorization,
    'Content-Type': 'application/json',
    Accept: input.stream ? 'text/event-stream' : 'application/json',
    'User-Agent': ANTIGRAVITY_RUNTIME_USER_AGENT,
  };
  return headers;
}

function buildClaudeRuntimeHeaders(input: {
  baseHeaders: Record<string, string>;
  claudeHeaders: Record<string, string>;
  anthropicVersion: string;
  stream: boolean;
  isClaudeOauthUpstream: boolean;
  tokenValue: string;
  extraBetas?: string[];
}): Record<string, string> {
  const anthropicBeta = mergeClaudeBetaHeader(
    getInputHeader(input.claudeHeaders, 'anthropic-beta'),
    input.extraBetas,
  );
  const headers: Record<string, string> = {
    ...input.baseHeaders,
    ...input.claudeHeaders,
    'anthropic-version': input.anthropicVersion,
    ...(anthropicBeta ? { 'anthropic-beta': anthropicBeta } : {}),
    'Anthropic-Dangerous-Direct-Browser-Access': 'true',
    'X-App': 'cli',
    'X-Stainless-Retry-Count': getInputHeader(input.claudeHeaders, 'x-stainless-retry-count') || '0',
    'X-Stainless-Runtime-Version': getInputHeader(input.claudeHeaders, 'x-stainless-runtime-version') || 'v24.3.0',
    'X-Stainless-Package-Version': getInputHeader(input.claudeHeaders, 'x-stainless-package-version') || '0.74.0',
    'X-Stainless-Runtime': getInputHeader(input.claudeHeaders, 'x-stainless-runtime') || 'node',
    'X-Stainless-Lang': getInputHeader(input.claudeHeaders, 'x-stainless-lang') || 'js',
    'X-Stainless-Arch': getInputHeader(input.claudeHeaders, 'x-stainless-arch') || 'x64',
    'X-Stainless-Os': getInputHeader(input.claudeHeaders, 'x-stainless-os') || 'Windows',
    'X-Stainless-Timeout': getInputHeader(input.claudeHeaders, 'x-stainless-timeout') || '600',
    'User-Agent': getInputHeader(input.claudeHeaders, 'user-agent') || CLAUDE_DEFAULT_USER_AGENT,
    Connection: 'keep-alive',
    Accept: input.stream ? 'text/event-stream' : 'application/json',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
  };
  if (input.isClaudeOauthUpstream) {
    headers.Authorization = `Bearer ${input.tokenValue}`;
  } else {
    headers['x-api-key'] = input.tokenValue;
  }
  return headers;
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

function normalizeResponsesFallbackChatFunctionTool(rawTool: unknown): Record<string, unknown> | null {
  if (!isRecord(rawTool)) return null;
  if (asTrimmedString(rawTool.type).toLowerCase() !== 'function') return null;

  if (isRecord(rawTool.function)) {
    const name = asTrimmedString(rawTool.function.name);
    if (!name) return null;
    return {
      ...rawTool,
      type: 'function',
      function: {
        ...rawTool.function,
        name,
        ...(rawTool.function.parameters !== undefined
          ? { parameters: sanitizeJsonSchemaForFunctionTool(rawTool.function.parameters) }
          : {}),
      },
    };
  }

  const name = asTrimmedString(rawTool.name);
  if (!name) return null;

  const fn: Record<string, unknown> = { name };
  const description = asTrimmedString(rawTool.description);
  if (description) fn.description = description;
  if (rawTool.parameters !== undefined) {
    fn.parameters = sanitizeJsonSchemaForFunctionTool(rawTool.parameters);
  }
  if (rawTool.strict !== undefined) fn.strict = rawTool.strict;

  return {
    type: 'function',
    function: fn,
  };
}

function normalizeResponsesFallbackChatToolChoice(
  rawToolChoice: unknown,
  allowedToolNames: Set<string>,
): unknown {
  if (rawToolChoice === undefined) return undefined;

  if (typeof rawToolChoice === 'string') {
    const normalized = rawToolChoice.trim().toLowerCase();
    if (normalized === 'none') return 'none';
    if (allowedToolNames.size <= 0) return undefined;
    if (normalized === 'auto' || normalized === 'required') return normalized;
    return undefined;
  }

  if (!isRecord(rawToolChoice)) return undefined;
  if (asTrimmedString(rawToolChoice.type).toLowerCase() !== 'function') return undefined;

  const nestedFunction = isRecord(rawToolChoice.function) ? rawToolChoice.function : null;
  const name = asTrimmedString(nestedFunction?.name ?? rawToolChoice.name);
  if (!name || !allowedToolNames.has(name)) return undefined;

  return {
    type: 'function',
    function: {
      ...(nestedFunction || {}),
      name,
    },
  };
}

function sanitizeResponsesFallbackChatBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...body,
    messages: sanitizeChatMessages(body.messages),
  };
  const normalizedTools = Array.isArray(body.tools)
    ? body.tools
      .map((tool) => normalizeResponsesFallbackChatFunctionTool(tool))
      .filter((tool): tool is Record<string, unknown> => !!tool)
    : [];

  if (normalizedTools.length > 0) {
    next.tools = normalizedTools;
  } else {
    delete next.tools;
  }

  const allowedToolNames = new Set(
    normalizedTools
      .map((tool) => (
        isRecord(tool.function)
          ? asTrimmedString(tool.function.name)
          : ''
      ))
      .filter((name) => name.length > 0),
  );
  const normalizedToolChoice = normalizeResponsesFallbackChatToolChoice(
    body.tool_choice,
    allowedToolNames,
  );
  if (normalizedToolChoice !== undefined) {
    next.tool_choice = normalizedToolChoice;
  } else {
    delete next.tool_choice;
  }

  if (next.response_format !== undefined) {
    next.response_format = sanitizeOpenAiResponseFormat(next.response_format);
  }

  return next;
}

function sanitizeDirectChatBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...body,
    messages: sanitizeChatMessages(body.messages),
  };
  const rawTools = Array.isArray(body.tools) ? body.tools : null;
  if (rawTools) {
    next.tools = rawTools.map((tool) => {
      if (!isRecord(tool)) return tool;
      if (asTrimmedString(tool.type).toLowerCase() !== 'function') return tool;

      if (isRecord(tool.function)) {
        return {
          ...tool,
          function: {
            ...tool.function,
            ...(tool.function.parameters !== undefined
              ? { parameters: sanitizeJsonSchemaForFunctionTool(tool.function.parameters) }
              : {}),
          },
        };
      }

      if (tool.parameters !== undefined) {
        return {
          ...tool,
          parameters: sanitizeJsonSchemaForFunctionTool(tool.parameters),
        };
      }

      return tool;
    });
  }
  if (next.response_format !== undefined) {
    next.response_format = sanitizeOpenAiResponseFormat(next.response_format);
  }
  return next;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function normalizeChatToolArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) || isRecord(value)) return safeJsonStringify(value);
  return '';
}

function normalizeChatToolMessageContent(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) || isRecord(value)) return safeJsonStringify(value);
  return value;
}

function sanitizeChatMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;

  const seenToolCallIds = new Set<string>();
  const sanitizedMessages: unknown[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isRecord(message)) {
      sanitizedMessages.push(message);
      continue;
    }

    const role = asTrimmedString(message.role).toLowerCase();
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      const sanitizedToolCalls = message.tool_calls
        .map((toolCall, toolIndex) => {
          if (!isRecord(toolCall)) return null;
          const functionPart = isRecord(toolCall.function) ? toolCall.function : null;
          const name = asTrimmedString(functionPart?.name ?? toolCall.name);
          if (!name) return null;

          const id = asTrimmedString(toolCall.id) || `call_${messageIndex}_${toolIndex}`;
          seenToolCallIds.add(id);

          return {
            ...toolCall,
            id,
            type: 'function',
            function: {
              ...(functionPart || {}),
              name,
              arguments: normalizeChatToolArguments(functionPart?.arguments ?? toolCall.arguments),
            },
          };
        })
        .filter(Boolean);

      const nextMessage: Record<string, unknown> = { ...message };
      if (sanitizedToolCalls.length > 0) {
        nextMessage.tool_calls = sanitizedToolCalls;
        if (nextMessage.content === undefined || nextMessage.content === null) {
          nextMessage.content = '';
        }
      } else {
        delete nextMessage.tool_calls;
      }
      sanitizedMessages.push(nextMessage);
      continue;
    }

    if (role === 'tool') {
      const toolCallId = asTrimmedString(message.tool_call_id ?? message.id);
      if (!toolCallId || !seenToolCallIds.has(toolCallId)) {
        continue;
      }
      sanitizedMessages.push({
        ...message,
        tool_call_id: toolCallId,
        content: normalizeChatToolMessageContent(message.content),
      });
      continue;
    }

    sanitizedMessages.push(message);
  }

  return sanitizedMessages;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ensureCodexResponsesInstructions(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  if (sitePlatform !== 'codex') return body;
  if (typeof body.instructions === 'string') return body;
  return {
    ...body,
    instructions: '',
  };
}

function ensureCodexResponsesStoreFalse(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  if (sitePlatform !== 'codex') return body;
  if (body.store === false) return body;
  return {
    ...body,
    store: false,
  };
}

function convertCodexSystemRoleToDeveloper(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (!isRecord(item)) return item;
    if (asTrimmedString(item.type).toLowerCase() !== 'message') return item;
    if (asTrimmedString(item.role).toLowerCase() !== 'system') return item;
    return {
      ...item,
      role: 'developer',
    };
  });
}

function applyCodexResponsesCompatibility(
  body: Record<string, unknown>,
  sitePlatform: string,
  options?: {
    preservePreviousResponseId?: boolean;
  },
): Record<string, unknown> {
  if (sitePlatform !== 'codex') return body;

  const next: Record<string, unknown> = {
    ...body,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    input: convertCodexSystemRoleToDeveloper(body.input),
  };

  if (typeof next.instructions !== 'string') {
    next.instructions = '';
  }

  for (const key of [
    'max_output_tokens',
    'max_completion_tokens',
    'temperature',
    'top_p',
    'truncation',
    'user',
    'context_management',
    'prompt_cache_retention',
    'safety_identifier',
  ]) {
    delete next[key];
  }
  if (!options?.preservePreviousResponseId) {
    delete next.previous_response_id;
  }

  if (asTrimmedString(next.service_tier).toLowerCase() !== 'priority') {
    delete next.service_tier;
  }

  return next;
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

function hasConcreteEndpointHint(rawValues: string[]): boolean {
  return rawValues.some((raw) => (
    raw.includes('/v1/messages')
    || raw.includes('/v1/chat/completions')
    || raw.includes('/v1/responses')
    || raw === 'messages'
    || raw === 'chat'
    || raw === 'chat_completions'
    || raw === 'completions'
    || raw === 'responses'
  ));
}

function hasMessagesFamilyHint(rawValues: string[]): boolean {
  return rawValues.some((raw) => (
    raw.includes('/v1/messages')
    || raw === 'messages'
    || raw.includes('anthropic')
    || raw.includes('claude')
  ));
}

function extendResponsesCandidatesWithMessages(
  candidates: UpstreamEndpoint[],
  input: {
    sitePlatform: string;
    supported: Set<UpstreamEndpoint>;
    hasMessagesFamilyHint: boolean;
  },
): UpstreamEndpoint[] {
  if (candidates.includes('messages')) return candidates;

  const shouldAllowMessages = (
    input.sitePlatform === 'claude'
    || input.sitePlatform === 'anyrouter'
    || input.hasMessagesFamilyHint
    || input.supported.has('messages')
  );
  if (!shouldAllowMessages) return candidates;

  const onlyMessagesSupported = (
    input.supported.has('messages')
    && !input.supported.has('chat')
    && !input.supported.has('responses')
  );
  if (onlyMessagesSupported) {
    return ['messages', ...candidates];
  }

  return [...candidates, 'messages'];
}

function buildEndpointCapabilityProfile(input?: {
  modelName?: string;
  requestedModelHint?: string;
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ConversationFileInputSummary;
    wantsNativeResponsesReasoning?: boolean;
  };
}): EndpointCapabilityProfile {
  const conversationFileSummary = input?.requestCapabilities?.conversationFileSummary;
  return {
    preferMessagesForClaudeModel: (
      isClaudeFamilyModel(asTrimmedString(input?.modelName))
      || isClaudeFamilyModel(asTrimmedString(input?.requestedModelHint))
    ),
    hasImageInput: conversationFileSummary?.hasImage === true,
    hasAudioInput: conversationFileSummary?.hasAudio === true,
    hasNonImageFileInput: (
      conversationFileSummary?.hasDocument === true
      || input?.requestCapabilities?.hasNonImageFileInput === true
    ),
    hasRemoteDocumentUrl: (
      conversationFileSummary?.hasRemoteDocumentUrl === true
    ),
    wantsNativeResponsesReasoning: input?.requestCapabilities?.wantsNativeResponsesReasoning === true,
  };
}

function shouldUseEndpointRuntimeMemory(capabilityProfile: EndpointCapabilityProfile): boolean {
  // Attachment-capable requests are not protocol-equivalent across chat/messages/responses.
  // A transient 200 on one endpoint should not bias later multimodal requests onto a lossy path.
  return (
    !capabilityProfile.hasImageInput
    && !capabilityProfile.hasAudioInput
    && !capabilityProfile.hasNonImageFileInput
  );
}

function hashCredentialFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function normalizeScopeSiteUrl(value: string | null | undefined): string {
  const trimmed = asTrimmedString(value);
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    const normalizedPath = pathname === '/' ? '' : pathname;
    return `${parsed.origin}${normalizedPath}`.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

function buildCredentialScopeLookupKey(siteUrl: string | null | undefined, tokenValue: string): string | null {
  const normalizedSiteUrl = normalizeScopeSiteUrl(siteUrl);
  const trimmedToken = asTrimmedString(tokenValue);
  if (!normalizedSiteUrl || !trimmedToken) return null;
  return `${normalizedSiteUrl}:${hashCredentialFingerprint(trimmedToken)}`;
}

function resolveCredentialScopeFromContext(context: ChannelContext): EndpointMemoryCredentialScope {
  const accountApiToken = asTrimmedString(context.account.apiToken);
  if (accountApiToken) {
    return {
      siteId: context.site.id,
      accountId: context.account.id,
      credentialSource: 'account_api_token',
      credentialFingerprint: hashCredentialFingerprint(accountApiToken),
    };
  }

  const accountAccessToken = asTrimmedString(context.account.accessToken);
  if (accountAccessToken) {
    return {
      siteId: context.site.id,
      accountId: context.account.id,
      credentialSource: 'account_access_token',
      credentialFingerprint: hashCredentialFingerprint(accountAccessToken),
    };
  }

  const siteApiKey = asTrimmedString(context.site.apiKey);
  if (siteApiKey) {
    return {
      siteId: context.site.id,
      accountId: null,
      credentialSource: 'site_api_key',
      credentialFingerprint: hashCredentialFingerprint(siteApiKey),
    };
  }

  return {
    siteId: context.site.id,
    accountId: context.account.id,
    credentialSource: 'none',
    credentialFingerprint: null,
  };
}

function rememberCredentialScopeBySiteAndToken(
  siteUrl: string | null | undefined,
  tokenValue: string | null | undefined,
  scope: EndpointMemoryCredentialScope,
): void {
  const key = buildCredentialScopeLookupKey(siteUrl, tokenValue || '');
  if (!key) return;
  if (endpointMemoryScopeBySiteAndToken.has(key)) {
    endpointMemoryScopeBySiteAndToken.delete(key);
  } else if (endpointMemoryScopeBySiteAndToken.size >= ENDPOINT_MEMORY_SCOPE_MAX_ENTRIES) {
    const oldestKey = endpointMemoryScopeBySiteAndToken.keys().next().value;
    if (typeof oldestKey === 'string' && oldestKey) {
      endpointMemoryScopeBySiteAndToken.delete(oldestKey);
    }
  }
  endpointMemoryScopeBySiteAndToken.set(key, scope);
}

function rememberCredentialScopesFromContext(context: ChannelContext): void {
  const accountApiToken = asTrimmedString(context.account.apiToken);
  if (accountApiToken) {
    rememberCredentialScopeBySiteAndToken(context.site.url, accountApiToken, {
      siteId: context.site.id,
      accountId: context.account.id,
      credentialSource: 'account_api_token',
      credentialFingerprint: hashCredentialFingerprint(accountApiToken),
    });
  }

  const accountAccessToken = asTrimmedString(context.account.accessToken);
  if (accountAccessToken) {
    rememberCredentialScopeBySiteAndToken(context.site.url, accountAccessToken, {
      siteId: context.site.id,
      accountId: context.account.id,
      credentialSource: 'account_access_token',
      credentialFingerprint: hashCredentialFingerprint(accountAccessToken),
    });
  }

  const siteApiKey = asTrimmedString(context.site.apiKey);
  if (siteApiKey) {
    rememberCredentialScopeBySiteAndToken(context.site.url, siteApiKey, {
      siteId: context.site.id,
      accountId: null,
      credentialSource: 'site_api_key',
      credentialFingerprint: hashCredentialFingerprint(siteApiKey),
    });
  }
}

function enterCredentialScopeForRequest(siteUrl: string | null | undefined, tokenValue: string): void {
  const key = buildCredentialScopeLookupKey(siteUrl, tokenValue);
  if (!key) return;
  const scope = endpointMemoryScopeBySiteAndToken.get(key);
  if (!scope) return;
  endpointMemoryScopeStorage.enterWith(scope);
}

function resolveCredentialScopeForMemory(input: {
  siteId: number;
  accountId?: number | null;
  accountAccessToken?: string | null;
  accountApiToken?: string | null;
  siteApiKey?: string | null;
}): EndpointMemoryCredentialScope {
  const accountApiToken = asTrimmedString(input.accountApiToken);
  if (accountApiToken) {
    return {
      siteId: input.siteId,
      accountId: input.accountId ?? null,
      credentialSource: 'account_api_token',
      credentialFingerprint: hashCredentialFingerprint(accountApiToken),
    };
  }

  const accountAccessToken = asTrimmedString(input.accountAccessToken);
  if (accountAccessToken) {
    return {
      siteId: input.siteId,
      accountId: input.accountId ?? null,
      credentialSource: 'account_access_token',
      credentialFingerprint: hashCredentialFingerprint(accountAccessToken),
    };
  }

  const siteApiKey = asTrimmedString(input.siteApiKey);
  if (siteApiKey) {
    return {
      siteId: input.siteId,
      accountId: null,
      credentialSource: 'site_api_key',
      credentialFingerprint: hashCredentialFingerprint(siteApiKey),
    };
  }

  if (input.accountId != null) {
    return {
      siteId: input.siteId,
      accountId: input.accountId,
      credentialSource: 'none',
      credentialFingerprint: null,
    };
  }

  const runtimeScope = endpointMemoryScopeStorage.getStore();
  if (runtimeScope && runtimeScope.siteId === input.siteId) {
    return runtimeScope;
  }

  return {
    siteId: input.siteId,
    accountId: input.accountId ?? null,
    credentialSource: 'none',
    credentialFingerprint: null,
  };
}

function buildEndpointRuntimeStateKey(input: {
  siteId: number;
  accountId?: number | null;
  accountAccessToken?: string | null;
  accountApiToken?: string | null;
  siteApiKey?: string | null;
  downstreamFormat: EndpointPreference;
  capabilityProfile: EndpointCapabilityProfile;
  modelName?: string | null;
}): string {
  const capabilityProfile = input.capabilityProfile;
  const credentialScope = resolveCredentialScopeForMemory({
    siteId: input.siteId,
    accountId: input.accountId,
    accountAccessToken: input.accountAccessToken,
    accountApiToken: input.accountApiToken,
    siteApiKey: input.siteApiKey,
  });
  return [
    String(input.siteId),
    credentialScope.accountId != null ? `acct:${credentialScope.accountId}` : 'acct:none',
    credentialScope.credentialSource,
    credentialScope.credentialFingerprint ? `cred:${credentialScope.credentialFingerprint}` : 'cred:none',
    normalizeEndpointRuntimeModelScope(input.modelName),
    input.downstreamFormat,
    capabilityProfile.preferMessagesForClaudeModel ? 'claude' : 'generic',
    capabilityProfile.hasNonImageFileInput ? 'files' : 'nofiles',
    capabilityProfile.hasRemoteDocumentUrl ? 'remoteurl' : 'noremoteurl',
    capabilityProfile.wantsNativeResponsesReasoning ? 'reasoning' : 'noreasoning',
  ].join(':');
}

function getOrCreateEndpointRuntimeState(key: string, nowMs = Date.now()): EndpointRuntimeState {
  const existing = endpointRuntimeStates.get(key);
  if (existing) return existing;

  const initial: EndpointRuntimeState = {
    preferredEndpoint: null,
    preferredUpdatedAtMs: nowMs,
    preferredReason: null,
    blockedUntilMsByEndpoint: {},
    probeAfterMs: null,
    lastProbeAtMs: null,
    lastProbeStatus: null,
  };
  endpointRuntimeStates.set(key, initial);
  return initial;
}

function maybeDeleteEndpointRuntimeState(key: string, nowMs = Date.now()): void {
  const state = endpointRuntimeStates.get(key);
  if (!state) return;

  const hasActiveBlock = Object.values(state.blockedUntilMsByEndpoint).some((untilMs) => (
    typeof untilMs === 'number' && untilMs > nowMs
  ));
  const preferredFresh = (
    !!state.preferredEndpoint
    && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs
  );
  const probeRelevant = (
    (typeof state.probeAfterMs === 'number' && state.probeAfterMs > 0)
    || state.lastProbeAtMs != null
    || state.lastProbeStatus != null
  );
  if (!hasActiveBlock && !preferredFresh && !probeRelevant) {
    endpointRuntimeStates.delete(key);
  }
}

function resolveEndpointRecoveryProbeAfterMs(blockedUntilMsByEndpoint: Partial<Record<UpstreamEndpoint, number>>, nowMs: number): number | null {
  const activeBlocks = Object.values(blockedUntilMsByEndpoint).filter((untilMs): untilMs is number => (
    typeof untilMs === 'number' && untilMs > nowMs
  ));
  if (activeBlocks.length === 0) return null;
  const nearestBlockUntilMs = Math.min(...activeBlocks);
  const remainingMs = Math.max(0, nearestBlockUntilMs - nowMs);
  return nowMs + Math.min(remainingMs, Math.max(10_000, Math.trunc(remainingMs * 0.5)));
}

function selectHalfOpenRuntimeEndpoint(
  candidates: UpstreamEndpoint[],
  state: EndpointRuntimeState,
  nowMs: number,
): UpstreamEndpoint | null {
  if (candidates.length === 0) return null;

  const preferredFresh = (
    !!state.preferredEndpoint
    && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs
    && candidates.includes(state.preferredEndpoint)
  );
  if (preferredFresh && state.preferredEndpoint) {
    return state.preferredEndpoint;
  }

  const ranked = [...candidates].sort((left, right) => {
    const leftUntilMs = state.blockedUntilMsByEndpoint[left] ?? Number.MAX_SAFE_INTEGER;
    const rightUntilMs = state.blockedUntilMsByEndpoint[right] ?? Number.MAX_SAFE_INTEGER;
    return leftUntilMs - rightUntilMs;
  });
  return ranked[0] || null;
}

function applyEndpointRuntimePreference(
  candidates: UpstreamEndpoint[],
  key: string,
  nowMs = Date.now(),
): UpstreamEndpoint[] {
  const state = endpointRuntimeStates.get(key);
  if (!state || candidates.length <= 1) return candidates;

  const blocked = new Set<UpstreamEndpoint>();
  for (const endpoint of candidates) {
    const untilMs = state.blockedUntilMsByEndpoint[endpoint];
    if (typeof untilMs === 'number' && untilMs > nowMs) {
      blocked.add(endpoint);
    }
  }

  let next = candidates.filter((endpoint) => !blocked.has(endpoint));
  if (next.length === 0) {
    const halfOpenEndpoint = selectHalfOpenRuntimeEndpoint(candidates, state, nowMs);
    if (halfOpenEndpoint) {
      state.lastProbeAtMs = nowMs;
      next = [halfOpenEndpoint];
    } else {
      next = [...candidates];
    }
  }

  const preferredFresh = (
    !!state.preferredEndpoint
    && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs
  );
  if (preferredFresh && state.preferredEndpoint && next.includes(state.preferredEndpoint)) {
    next = [
      state.preferredEndpoint,
      ...next.filter((endpoint) => endpoint !== state.preferredEndpoint),
    ];
  }

  maybeDeleteEndpointRuntimeState(key, nowMs);
  return next;
}

function inferSuggestedEndpointFromError(errorText?: string | null): UpstreamEndpoint | null {
  const text = (errorText || '').toLowerCase();
  if (!text) return null;
  const explicitSuggestionPatterns: Array<{ endpoint: UpstreamEndpoint; pattern: RegExp }> = [
    { endpoint: 'responses', pattern: /(?:please|try)\s+use\s+\/v1\/responses/i },
    { endpoint: 'messages', pattern: /(?:please|try)\s+use\s+\/v1\/messages/i },
    { endpoint: 'chat', pattern: /(?:please|try)\s+use\s+\/v1\/chat\/completions/i },
    { endpoint: 'responses', pattern: /use\s+\/v1\/responses\s+instead/i },
    { endpoint: 'messages', pattern: /use\s+\/v1\/messages\s+instead/i },
    { endpoint: 'chat', pattern: /use\s+\/v1\/chat\/completions\s+instead/i },
  ];
  for (const candidate of explicitSuggestionPatterns) {
    if (candidate.pattern.test(errorText || '')) return candidate.endpoint;
  }
  if (text.includes('/v1/responses')) return 'responses';
  if (text.includes('/v1/messages')) return 'messages';
  if (text.includes('/v1/chat/completions')) return 'chat';
  return null;
}

function shouldBlockEndpointByError(status: number, errorText?: string | null): boolean {
  if (isEndpointDispatchDeniedError(status, errorText)) return true;
  if (status === 404 || status === 405 || status === 415 || status === 501) return true;
  if (isUnsupportedMediaTypeError(status, errorText)) return true;
  return hasExplicitEndpointCompatibilitySignal(errorText);
}

function shouldRememberSuccessfulEndpoint(input: {
  endpoint: UpstreamEndpoint;
  downstreamFormat: EndpointPreference;
  capabilityProfile: EndpointCapabilityProfile;
}): boolean {
  if (input.downstreamFormat !== 'responses') return true;
  if (input.endpoint === 'responses') return true;
  if (input.endpoint === 'chat') return true;
  return input.capabilityProfile.preferMessagesForClaudeModel;
}

function shouldPersistFailureRuntimeMemory(input: {
  endpoint: UpstreamEndpoint;
  suggestedEndpoint: UpstreamEndpoint | null;
  downstreamFormat: EndpointPreference;
  capabilityProfile: EndpointCapabilityProfile;
}): boolean {
  if (
    input.downstreamFormat === 'responses'
    && !input.capabilityProfile.preferMessagesForClaudeModel
    && input.suggestedEndpoint === 'messages'
    && input.endpoint !== 'messages'
  ) {
    return false;
  }

  return true;
}

export function resetUpstreamEndpointRuntimeState(): void {
  endpointRuntimeStates.clear();
  endpointMemoryScopeBySiteAndToken.clear();
  resetUpstreamProtocolProfileState();
}

export function getUpstreamEndpointRuntimeMemorySnapshot(nowMs = Date.now()): UpstreamEndpointRuntimeMemoryEntry[] {
  const snapshot: UpstreamEndpointRuntimeMemoryEntry[] = [];
  for (const [key, state] of endpointRuntimeStates.entries()) {
    const activeBlocks = (['chat', 'messages', 'responses'] as const).filter((endpoint) => {
      const untilMs = state.blockedUntilMsByEndpoint[endpoint];
      return typeof untilMs === 'number' && untilMs > nowMs;
    });
    const hasFreshPreference = (
      !!state.preferredEndpoint
      && (state.preferredUpdatedAtMs + ENDPOINT_RUNTIME_PREFERRED_TTL_MS) > nowMs
    );
    if (!hasFreshPreference && activeBlocks.length === 0) continue;
    snapshot.push({
      key,
      preferredEndpoint: state.preferredEndpoint,
      preferredUpdatedAtMs: state.preferredUpdatedAtMs,
      preferredReason: state.preferredReason,
      blockedUntilMsByEndpoint: { ...state.blockedUntilMsByEndpoint },
      activeBlocks,
      hasFreshPreference,
      probeAfterMs: state.probeAfterMs,
      probeReady: typeof state.probeAfterMs === 'number' && state.probeAfterMs <= nowMs,
      lastProbeAtMs: state.lastProbeAtMs,
      lastProbeStatus: state.lastProbeStatus,
    });
  }

  snapshot.sort((left, right) => (
    right.activeBlocks.length - left.activeBlocks.length
    || right.preferredUpdatedAtMs - left.preferredUpdatedAtMs
    || left.key.localeCompare(right.key, undefined, { sensitivity: 'base' })
  ));
  return snapshot;
}

export function getEndpointMemoryCredentialScopeSnapshot(): EndpointMemoryCredentialScopeEntry[] {
  const snapshot: EndpointMemoryCredentialScopeEntry[] = [];
  for (const [cacheKey, scope] of endpointMemoryScopeBySiteAndToken.entries()) {
    snapshot.push({
      cacheKey,
      siteId: scope.siteId,
      accountId: scope.accountId,
      credentialSource: scope.credentialSource,
      credentialFingerprint: scope.credentialFingerprint,
    });
  }

  snapshot.sort((left, right) => (
    left.siteId - right.siteId
    || (left.accountId ?? 0) - (right.accountId ?? 0)
    || left.credentialSource.localeCompare(right.credentialSource, undefined, { sensitivity: 'base' })
    || left.cacheKey.localeCompare(right.cacheKey, undefined, { sensitivity: 'base' })
  ));
  return snapshot;
}

export function recordUpstreamEndpointSuccess(input: {
  siteId: number;
  accountId?: number;
  accountAccessToken?: string | null;
  accountApiToken?: string | null;
  siteApiKey?: string | null;
  endpoint: UpstreamEndpoint;
  downstreamFormat: EndpointPreference;
  modelName?: string;
  requestedModelHint?: string;
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ConversationFileInputSummary;
    wantsNativeResponsesReasoning?: boolean;
  };
}): void {
  const capabilityProfile = buildEndpointCapabilityProfile({
    modelName: input.modelName,
    requestedModelHint: input.requestedModelHint,
    requestCapabilities: input.requestCapabilities,
  });
  if (!shouldUseEndpointRuntimeMemory(capabilityProfile)) return;
  if (!shouldRememberSuccessfulEndpoint({
    ...input,
    capabilityProfile,
  })) return;

  const nowMs = Date.now();
  const key = buildEndpointRuntimeStateKey({
    siteId: input.siteId,
    accountId: input.accountId,
    accountAccessToken: input.accountAccessToken,
    accountApiToken: input.accountApiToken,
    siteApiKey: input.siteApiKey,
    downstreamFormat: input.downstreamFormat,
    capabilityProfile,
    modelName: input.modelName || input.requestedModelHint || null,
  });
  const state = getOrCreateEndpointRuntimeState(key, nowMs);
  state.preferredEndpoint = input.endpoint;
  state.preferredUpdatedAtMs = nowMs;
  state.preferredReason = 'success';
  delete state.blockedUntilMsByEndpoint[input.endpoint];
  state.probeAfterMs = null;
  state.lastProbeAtMs = nowMs;
  state.lastProbeStatus = 'success';
  recordPersistedUpstreamEndpointSuccess({
    key,
    endpoint: input.endpoint,
    nowMs,
  });
}

export function recordUpstreamEndpointFailure(input: {
  siteId: number;
  sitePlatform?: string | null;
  accountId?: number;
  accountAccessToken?: string | null;
  accountApiToken?: string | null;
  siteApiKey?: string | null;
  endpoint: UpstreamEndpoint;
  downstreamFormat: EndpointPreference;
  status: number;
  errorText?: string | null;
  modelName?: string;
  requestedModelHint?: string;
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ConversationFileInputSummary;
    wantsNativeResponsesReasoning?: boolean;
  };
}): void {
  const capabilityProfile = buildEndpointCapabilityProfile({
    modelName: input.modelName,
    requestedModelHint: input.requestedModelHint,
    requestCapabilities: input.requestCapabilities,
  });
  if (!shouldUseEndpointRuntimeMemory(capabilityProfile)) return;
  const shouldBlockForGenericMessagesWrapper = shouldDowngradeMessagesEndpointAfterGenericBadResponseWrapper({
    status: input.status,
    upstreamErrorText: input.errorText,
    sitePlatform: input.sitePlatform,
    modelName: input.modelName,
    requestedModelHint: input.requestedModelHint,
    currentEndpoint: input.endpoint,
  });
  if (!shouldBlockEndpointByError(input.status, input.errorText) && !shouldBlockForGenericMessagesWrapper) return;

  const suggestedEndpoint = inferSuggestedEndpointFromError(input.errorText);
  if (!shouldPersistFailureRuntimeMemory({
    endpoint: input.endpoint,
    suggestedEndpoint,
    downstreamFormat: input.downstreamFormat,
    capabilityProfile,
  })) {
    return;
  }

  const nowMs = Date.now();
  const key = buildEndpointRuntimeStateKey({
    siteId: input.siteId,
    accountId: input.accountId,
    accountAccessToken: input.accountAccessToken,
    accountApiToken: input.accountApiToken,
    siteApiKey: input.siteApiKey,
    downstreamFormat: input.downstreamFormat,
    capabilityProfile,
    modelName: input.modelName || input.requestedModelHint || null,
  });
  const state = getOrCreateEndpointRuntimeState(key, nowMs);
  state.blockedUntilMsByEndpoint[input.endpoint] = nowMs + ENDPOINT_RUNTIME_BLOCK_TTL_MS;
  if (suggestedEndpoint && suggestedEndpoint !== input.endpoint) {
    state.preferredEndpoint = suggestedEndpoint;
    state.preferredUpdatedAtMs = nowMs;
    state.preferredReason = 'suggested';
    delete state.blockedUntilMsByEndpoint[suggestedEndpoint];
  }
  state.probeAfterMs = resolveEndpointRecoveryProbeAfterMs(state.blockedUntilMsByEndpoint, nowMs);
  state.lastProbeAtMs = nowMs;
  state.lastProbeStatus = 'failed';
  recordPersistedUpstreamEndpointFailure({
    key,
    endpoint: input.endpoint,
    suggestedEndpoint,
    blockTtlMs: ENDPOINT_RUNTIME_BLOCK_TTL_MS,
    nowMs,
  });
}

function preferredEndpointOrder(
  downstreamFormat: EndpointPreference,
  sitePlatform?: string,
  preferMessagesForClaudeModel = false,
): UpstreamEndpoint[] {
  const platform = normalizePlatformName(sitePlatform);

  if (platform === 'codex') {
    return ['responses'];
  }

  if (platform === 'gemini') {
    // Gemini upstream is routed through OpenAI-compatible chat endpoint.
    return ['chat'];
  }

  if (platform === 'gemini-cli') {
    return ['chat'];
  }

  if (platform === 'antigravity') {
    return ['chat'];
  }

  if (platform === 'openai') {
    if (preferMessagesForClaudeModel && downstreamFormat !== 'responses') {
      // Some OpenAI-compatible gateways expose Claude natively via /v1/messages.
      // Keep chat/responses as fallbacks when messages is unavailable.
      return ['messages', 'chat', 'responses'];
    }
    if (preferMessagesForClaudeModel && downstreamFormat === 'responses') {
      return ['responses', 'chat', 'messages'];
    }
    return downstreamFormat === 'responses'
      ? ['responses', 'chat']
      : ['chat', 'responses'];
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
    return ['responses', 'chat'];
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
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ConversationFileInputSummary;
    wantsNativeResponsesReasoning?: boolean;
  },
): Promise<UpstreamEndpoint[]> {
  const credentialScope = resolveCredentialScopeFromContext(context);
  rememberCredentialScopesFromContext(context);
  const sitePlatform = normalizePlatformName(context.site.platform);
  const capabilityProfile = buildEndpointCapabilityProfile({
    modelName,
    requestedModelHint,
    requestCapabilities,
  });
  const preferMessagesForClaudeModel = capabilityProfile.preferMessagesForClaudeModel;
  const hasNonImageFileInput = capabilityProfile.hasNonImageFileInput;
  const wantsNativeResponsesReasoning = capabilityProfile.wantsNativeResponsesReasoning;
  const runtimeStateKey = buildEndpointRuntimeStateKey({
    siteId: context.site.id,
    accountId: credentialScope.accountId,
    accountAccessToken: credentialScope.credentialSource === 'account_access_token'
      ? context.account.accessToken ?? null
      : null,
    accountApiToken: credentialScope.credentialSource === 'account_api_token'
      ? context.account.apiToken ?? null
      : null,
    siteApiKey: credentialScope.credentialSource === 'site_api_key'
      ? context.site.apiKey ?? null
      : null,
    downstreamFormat,
    capabilityProfile,
    modelName,
  });
  const applyLearnedPreference = async (candidates: UpstreamEndpoint[]) => {
    const manuallyConstrained = await applyManualSiteProtocolConfig(candidates, context.site.id, context.site.platform);
    if (!shouldUseEndpointRuntimeMemory(capabilityProfile)) {
      return manuallyConstrained.candidates;
    }
    const persistedCandidates = await applyPersistedUpstreamEndpointPreference(
      manuallyConstrained.candidates,
      runtimeStateKey,
    );
    return applyEndpointRuntimePreference(persistedCandidates, runtimeStateKey);
  };
  const conversationFileSummary = requestCapabilities?.conversationFileSummary ?? {
    hasImage: false,
    hasAudio: false,
    hasDocument: hasNonImageFileInput,
    hasRemoteDocumentUrl: false,
  };
  if (sitePlatform === 'anyrouter') {
    // anyrouter deployments are effectively anthropic-protocol first.
    if (hasNonImageFileInput) {
      return await applyLearnedPreference(downstreamFormat === 'responses'
        ? ['responses', 'messages', 'chat']
        : ['messages', 'responses', 'chat']);
    }
    if (downstreamFormat === 'responses') {
      return await applyLearnedPreference(['responses', 'messages', 'chat']);
    }
    return await applyLearnedPreference(['messages', 'chat', 'responses']);
  }

  const preferred = preferredEndpointOrder(
    downstreamFormat,
    context.site.platform,
    preferMessagesForClaudeModel,
  );
  const preferredWithCapabilities = hasNonImageFileInput
    ? (() => {
      if (sitePlatform === 'claude') return ['messages'] as UpstreamEndpoint[];
      if (sitePlatform === 'gemini') return ['responses', 'chat'] as UpstreamEndpoint[];
      if (sitePlatform === 'gemini-cli' || sitePlatform === 'antigravity') return ['chat'] as UpstreamEndpoint[];
      return rankConversationFileEndpoints({
        sitePlatform,
        requestedOrder: preferMessagesForClaudeModel
          ? ['messages', 'responses', 'chat']
          : ['responses', 'messages', 'chat'],
        summary: conversationFileSummary,
        preferMessagesForClaudeModel,
      });
    })()
    : preferred;
  const prioritizedPreferredEndpoints: UpstreamEndpoint[] = (
    wantsNativeResponsesReasoning
    && preferMessagesForClaudeModel
    && preferredWithCapabilities.includes('responses')
  )
    ? [
      'responses',
      ...preferredWithCapabilities.filter((endpoint): endpoint is UpstreamEndpoint => endpoint !== 'responses'),
    ]
    : preferredWithCapabilities;
  const forceMessagesFirstForClaudeModel = (
    downstreamFormat === 'openai'
    && preferMessagesForClaudeModel
    && sitePlatform !== 'openai'
    && sitePlatform !== 'gemini'
    && sitePlatform !== 'antigravity'
    && sitePlatform !== 'gemini-cli'
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
      return await applyLearnedPreference(prioritizedPreferredEndpoints);
    }

    const matched = catalog.models.find((item) =>
      asTrimmedString(item?.modelName).toLowerCase() === modelName.toLowerCase(),
    );
    if (!matched) return await applyLearnedPreference(prioritizedPreferredEndpoints);

    const shouldIgnoreCatalogOrderingForClaudeMessages = (
      preferMessagesForClaudeModel
      && (downstreamFormat !== 'responses' || sitePlatform !== 'openai')
    );
    if (shouldIgnoreCatalogOrderingForClaudeMessages) {
      return await applyLearnedPreference(prioritizedPreferredEndpoints);
    }

    const supportedRaw = Array.isArray(matched.supportedEndpointTypes) ? matched.supportedEndpointTypes : [];
    const normalizedSupportedRaw = supportedRaw
      .map((item) => asTrimmedString(item).toLowerCase())
      .filter((item) => item.length > 0);
    const hasConcreteCatalogHint = hasConcreteEndpointHint(normalizedSupportedRaw);
    const hasMessagesCatalogHint = hasMessagesFamilyHint(normalizedSupportedRaw);
    if (forceMessagesFirstForClaudeModel && !hasConcreteCatalogHint) {
      // Generic labels like openai/anthropic are too coarse for Claude models;
      // keep messages-first order in this case.
      return await applyLearnedPreference(prioritizedPreferredEndpoints);
    }

    const supported = new Set<UpstreamEndpoint>();
    for (const endpoint of supportedRaw) {
      const normalizedList = normalizeEndpointTypes(endpoint);
      for (const normalized of normalizedList) {
        supported.add(normalized);
      }
    }

    if (supported.size === 0) return await applyLearnedPreference(prioritizedPreferredEndpoints);

    if (
      downstreamFormat === 'responses'
      && !prioritizedPreferredEndpoints.includes('messages')
      && supported.has('messages')
      && !supported.has('chat')
      && !supported.has('responses')
    ) {
      return await applyLearnedPreference(['messages']);
    }

    const candidatePool = downstreamFormat === 'responses'
      ? extendResponsesCandidatesWithMessages(prioritizedPreferredEndpoints, {
        sitePlatform,
        supported,
        hasMessagesFamilyHint: hasMessagesCatalogHint,
      })
      : prioritizedPreferredEndpoints;

    if (hasConcreteCatalogHint) {
      const concreteCandidatePool: UpstreamEndpoint[] = [
        ...candidatePool,
        ...(['responses', 'chat', 'messages'] as UpstreamEndpoint[]).filter(
          (endpoint) => !candidatePool.includes(endpoint),
        ),
      ];
      const concreteSupportedOrder = concreteCandidatePool.filter((endpoint) => supported.has(endpoint));
      if (concreteSupportedOrder.length > 0) {
        return await applyLearnedPreference(concreteSupportedOrder);
      }
    }

    const firstSupported = candidatePool.find((endpoint) => supported.has(endpoint));
    if (!firstSupported) return await applyLearnedPreference(candidatePool);

    // Catalog metadata can be incomplete/inaccurate, so only use coarse labels
    // to pick the first attempt. Keep downstream-driven fallback order unchanged.
    return await applyLearnedPreference([
      firstSupported,
      ...candidatePool.filter((endpoint) => endpoint !== firstSupported),
    ]);
  } catch {
    return await applyLearnedPreference(prioritizedPreferredEndpoints);
  }
}

export function buildUpstreamEndpointRequest(input: {
  endpoint: UpstreamEndpoint;
  modelName: string;
  stream: boolean;
  tokenValue: string;
  oauthProvider?: string;
  oauthProjectId?: string;
  sitePlatform?: string;
  siteUrl?: string;
  openaiBody: Record<string, unknown>;
  downstreamFormat: EndpointPreference;
  claudeOriginalBody?: Record<string, unknown>;
  forceNormalizeClaudeBody?: boolean;
  responsesOriginalBody?: Record<string, unknown>;
  downstreamHeaders?: Record<string, unknown>;
  providerHeaders?: Record<string, string>;
  codexSessionCacheKey?: string | null;
  codexExplicitSessionId?: string | null;
}): {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime?: {
    executor: 'default' | 'codex' | 'gemini-cli' | 'antigravity' | 'claude';
    modelName?: string;
    stream?: boolean;
    oauthProjectId?: string | null;
    action?: 'generateContent' | 'streamGenerateContent' | 'countTokens';
  };
} {
  enterCredentialScopeForRequest(input.siteUrl, input.tokenValue);
  const sitePlatform = normalizePlatformName(input.sitePlatform);
  const providerProfile = resolveProviderProfile(sitePlatform);
  const isClaudeUpstream = sitePlatform === 'claude';
  const isGeminiUpstream = sitePlatform === 'gemini';
  const isGeminiCliUpstream = sitePlatform === 'gemini-cli';
  const isAntigravityUpstream = sitePlatform === 'antigravity';
  const isInternalGeminiUpstream = isGeminiCliUpstream || isAntigravityUpstream;
  const isClaudeOauthUpstream = isClaudeUpstream && input.oauthProvider === 'claude';

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
    if (isGeminiUpstream) {
      return resolveGeminiEndpointPath(endpoint);
    }

    if (sitePlatform === 'openai') {
      if (endpoint === 'messages') return '/v1/messages';
      if (endpoint === 'responses') return '/v1/responses';
      return '/v1/chat/completions';
    }

    if (sitePlatform === 'codex') {
      return '/responses';
    }

    if (sitePlatform === 'gemini-cli' || sitePlatform === 'antigravity') {
      return input.stream
        ? '/v1internal:streamGenerateContent?alt=sse'
        : '/v1internal:generateContent';
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
    ...(input.providerHeaders || {}),
  };
  if (!isClaudeUpstream) {
    commonHeaders.Authorization = `Bearer ${input.tokenValue}`;
  }

  const stripGeminiUnsupportedFields = (body: Record<string, unknown>) => {
    const next = { ...body };
    if (isGeminiUpstream || isInternalGeminiUpstream) {
      for (const key of [
        'frequency_penalty',
        'presence_penalty',
        'logit_bias',
        'logprobs',
        'top_logprobs',
        'store',
      ]) {
        delete next[key];
      }
    }
    return next;
  };

  const openaiBody = stripGeminiUnsupportedFields(input.openaiBody);
  const runtime = {
    executor: (
      sitePlatform === 'codex'
        ? 'codex'
        : sitePlatform === 'gemini-cli'
          ? 'gemini-cli'
          : sitePlatform === 'antigravity'
            ? 'antigravity'
            : sitePlatform === 'claude'
              ? 'claude'
              : 'default'
    ) as 'default' | 'codex' | 'gemini-cli' | 'antigravity' | 'claude',
    modelName: input.modelName,
    stream: input.stream,
    oauthProjectId: asTrimmedString(input.oauthProjectId) || null,
  };
  const requestedModelForPayloadRules = resolveRequestedModelForPayloadRules(input);
  const applyConfiguredPayloadRules = <T extends Record<string, unknown>>(body: T): T => (
    applyPayloadRules({
      rules: config.payloadRules,
      payload: body,
      modelName: input.modelName,
      requestedModel: requestedModelForPayloadRules,
      protocol: sitePlatform,
    }) as T
  );

  if (isInternalGeminiUpstream) {
    const instructions = (
      input.downstreamFormat === 'responses'
      && typeof input.responsesOriginalBody?.instructions === 'string'
    )
      ? input.responsesOriginalBody.instructions
      : undefined;
    const geminiRequest = buildGeminiGenerateContentRequestFromOpenAi({
      body: openaiBody,
      modelName: input.modelName,
      instructions,
    });
    const configuredGeminiRequest = applyConfiguredPayloadRules(geminiRequest);
    if (!providerProfile) {
      throw new Error(`missing provider profile for platform: ${sitePlatform}`);
    }
    return providerProfile.prepareRequest({
      endpoint: input.endpoint,
      modelName: input.modelName,
      stream: input.stream,
      tokenValue: input.tokenValue,
      oauthProvider: input.oauthProvider,
      oauthProjectId: input.oauthProjectId,
      sitePlatform,
      baseHeaders: commonHeaders,
      providerHeaders: input.providerHeaders,
      body: configuredGeminiRequest,
      action: input.stream ? 'streamGenerateContent' : 'generateContent',
    });
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
    const nativeClaudeBody = (
      input.downstreamFormat === 'claude'
      && input.claudeOriginalBody
      && input.forceNormalizeClaudeBody !== true
    )
      ? {
        ...input.claudeOriginalBody,
        model: input.modelName,
        stream: input.stream,
      }
      : null;
    const normalizedClaudeBody = (
      input.downstreamFormat === 'claude'
      && input.claudeOriginalBody
      && input.forceNormalizeClaudeBody === true
    )
      ? sanitizeAnthropicMessagesBody({
        ...input.claudeOriginalBody,
        model: input.modelName,
        stream: input.stream,
      })
      : null;
    const sanitizedBody = nativeClaudeBody
      ?? normalizedClaudeBody
      ?? sanitizeAnthropicMessagesBody(
        convertOpenAiBodyToAnthropicMessagesBody(openaiBody, input.modelName, input.stream),
      );
    const configuredClaudeBody = applyConfiguredPayloadRules(sanitizedBody);

    if (providerProfile?.id === 'claude') {
      return providerProfile.prepareRequest({
        endpoint: 'messages',
        modelName: input.modelName,
        stream: input.stream,
        tokenValue: input.tokenValue,
        oauthProvider: input.oauthProvider,
        oauthProjectId: input.oauthProjectId,
        sitePlatform,
        baseHeaders: commonHeaders,
        claudeHeaders,
        body: configuredClaudeBody,
      });
    }

    const headers = buildClaudeRuntimeHeaders({
      baseHeaders: commonHeaders,
      claudeHeaders,
      anthropicVersion,
      stream: input.stream,
      isClaudeOauthUpstream,
      tokenValue: input.tokenValue,
    });

    return {
      path: resolveEndpointPath('messages'),
      headers,
      body: configuredClaudeBody,
      runtime,
    };
  }

  if (input.endpoint === 'responses') {
    const websocketMode = Object.entries(input.downstreamHeaders || {}).find(([rawKey]) => rawKey.trim().toLowerCase() === 'x-metapi-responses-websocket-mode');
    const preserveWebsocketIncrementalMode = asTrimmedString(websocketMode?.[1]).toLowerCase() === 'incremental';
    const responsesHeaders = input.downstreamFormat === 'responses'
      ? extractResponsesPassthroughHeaders(input.downstreamHeaders)
      : {};
    const rawBody = (
      input.downstreamFormat === 'responses' && input.responsesOriginalBody
        ? {
          ...stripGeminiUnsupportedFields(input.responsesOriginalBody),
          model: input.modelName,
          stream: input.stream,
        }
        : convertOpenAiBodyToResponsesBodyViaTransformer(openaiBody, input.modelName, input.stream)
    );
    const sanitizedResponsesBody = sanitizeResponsesBodyForProxyViaTransformer(rawBody, input.modelName, input.stream);
    if (preserveWebsocketIncrementalMode && rawBody.generate === false) {
      sanitizedResponsesBody.generate = false;
    }
    const body = ensureCodexResponsesStoreFalse(
      ensureCodexResponsesInstructions(
        applyCodexResponsesCompatibility(
          sanitizedResponsesBody,
          sitePlatform,
          { preservePreviousResponseId: preserveWebsocketIncrementalMode },
        ),
        sitePlatform,
      ),
      sitePlatform,
    );
    const configuredResponsesBody = applyConfiguredPayloadRules(body);

    if (providerProfile?.id === 'codex') {
      return providerProfile.prepareRequest({
        endpoint: 'responses',
        modelName: input.modelName,
        stream: input.stream,
        tokenValue: input.tokenValue,
        oauthProvider: input.oauthProvider,
        oauthProjectId: input.oauthProjectId,
        sitePlatform,
        baseHeaders: {
          ...commonHeaders,
          ...responsesHeaders,
        },
        providerHeaders: input.providerHeaders,
        codexSessionCacheKey: input.codexSessionCacheKey,
        codexExplicitSessionId: input.codexExplicitSessionId,
        body: configuredResponsesBody,
      });
    }

    const headers = sitePlatform === 'codex'
      ? buildCodexRuntimeHeaders({
        baseHeaders: {
          ...commonHeaders,
          ...responsesHeaders,
        },
        providerHeaders: input.providerHeaders,
        explicitSessionId: asTrimmedString(input.codexExplicitSessionId) || null,
        continuityKey: asTrimmedString(input.codexSessionCacheKey) || null,
      })
      : ensureStreamAcceptHeader({
        ...commonHeaders,
        ...responsesHeaders,
      }, input.stream);
    const codexSessionId = sitePlatform === 'codex'
      ? (getInputHeader(headers, 'session_id') || getInputHeader(headers, 'session-id'))
      : null;
    const shouldInjectDerivedPromptCacheKey = sitePlatform === 'codex'
      && !!codexSessionId
      && !asTrimmedString((configuredResponsesBody as Record<string, unknown>).prompt_cache_key)
      && !asTrimmedString(input.codexExplicitSessionId)
      && !!asTrimmedString(input.codexSessionCacheKey);
    const runtimeBody = shouldInjectDerivedPromptCacheKey
      ? {
        ...configuredResponsesBody,
        prompt_cache_key: codexSessionId,
      }
      : configuredResponsesBody;

    return {
      path: resolveEndpointPath('responses'),
      headers,
      body: runtimeBody,
      runtime,
    };
  }

  const headers = ensureStreamAcceptHeader(commonHeaders, input.stream);
  const chatBody = sanitizeDirectChatBody({
    ...openaiBody,
    model: input.modelName,
    stream: input.stream,
  });
  const configuredChatBody = applyConfiguredPayloadRules(
    input.downstreamFormat === 'responses'
      ? sanitizeResponsesFallbackChatBody(chatBody)
      : chatBody,
  );
  return {
    path: resolveEndpointPath('chat'),
    headers,
    body: configuredChatBody,
    runtime,
  };
}

export function buildClaudeCountTokensUpstreamRequest(input: {
  modelName: string;
  tokenValue: string;
  oauthProvider?: string;
  sitePlatform?: string;
  claudeBody: Record<string, unknown>;
  downstreamHeaders?: Record<string, unknown>;
}): {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime: {
    executor: 'claude';
    modelName: string;
    stream: false;
    action: 'countTokens';
  };
} {
  const sitePlatform = normalizePlatformName(input.sitePlatform);
  const claudeHeaders = extractClaudePassthroughHeaders(input.downstreamHeaders);
  const { body: bodyWithoutBetas, betas } = extractClaudeBetasFromBody({
    ...input.claudeBody,
    model: input.modelName,
  });
  const sanitizedBody = sanitizeAnthropicMessagesBody(bodyWithoutBetas);
  delete sanitizedBody.max_tokens;
  delete sanitizedBody.maxTokens;
  delete sanitizedBody.stream;
  const providerProfile = resolveProviderProfile(sitePlatform);
  const effectiveClaudeHeaders = {
    ...claudeHeaders,
    ...(betas.length > 0 ? { 'anthropic-beta': betas.join(',') } : {}),
  };

  if (providerProfile?.id === 'claude') {
    const prepared = providerProfile.prepareRequest({
      endpoint: 'messages',
      modelName: input.modelName,
      stream: false,
      tokenValue: input.tokenValue,
      oauthProvider: input.oauthProvider,
      sitePlatform,
      baseHeaders: {
        'Content-Type': 'application/json',
      },
      claudeHeaders: effectiveClaudeHeaders,
      body: sanitizedBody,
      action: 'countTokens',
    });

    return {
      path: prepared.path,
      headers: prepared.headers,
      body: prepared.body,
      runtime: {
        executor: 'claude',
        modelName: input.modelName,
        stream: false,
        action: 'countTokens',
      },
    };
  }

  const anthropicVersion = (
    effectiveClaudeHeaders['anthropic-version']
    || '2023-06-01'
  );
  const isClaudeOauthUpstream = sitePlatform === 'claude' && input.oauthProvider === 'claude';
  const headers = buildClaudeRuntimeHeaders({
    baseHeaders: {
      'Content-Type': 'application/json',
    },
    claudeHeaders: effectiveClaudeHeaders,
    anthropicVersion,
    stream: false,
    isClaudeOauthUpstream,
    tokenValue: input.tokenValue,
  });

  return {
    path: '/v1/messages/count_tokens?beta=true',
    headers,
    body: sanitizedBody,
    runtime: {
      executor: 'claude',
      modelName: input.modelName,
      stream: false,
      action: 'countTokens',
    },
  };
}
