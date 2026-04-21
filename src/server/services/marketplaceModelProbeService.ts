import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { ensureDefaultTokenForAccount, getPreferredAccountToken, isUsableAccountToken, syncTokensFromUpstream } from './accountTokenService.js';
import { resolvePlatformUserId } from './accountExtraConfig.js';
import { fetchModelPricingCatalog } from './modelPricingService.js';
import { getAdapter } from './platforms/index.js';
import { withSiteProxyRequestInit } from './siteProxy.js';
import { pullSseDataEvents } from './proxyUsageParser.js';
import { autoProvisionTokenCoverage } from './tokenCoverageAutoProvisionService.js';

const MARKETPLACE_MODEL_TEST_TIMEOUT_MS = 90_000;
const MARKETPLACE_AUTO_KEY_TIMEOUT_MS = 15_000;
const MARKETPLACE_MODEL_PROBE_TIMEOUT_MS = 30_000;
const LOCAL_PROXY_CANARY_TIMEOUT_MS = 20_000;

type AccountRow = typeof schema.accounts.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;
type AccountTokenRow = typeof schema.accountTokens.$inferSelect;

export type MarketplaceProbeClassification =
  | 'supported'
  | 'model_unavailable'
  | 'credential'
  | 'protocol_mismatch'
  | 'inconclusive';

export type MarketplaceProbeResult = {
  available: boolean | null;
  reason: string;
  checkedUrl: string | null;
  statusCode: number | null;
  endpoint: string | null;
  classification: MarketplaceProbeClassification;
};

export type MarketplaceProbeCandidate = {
  account: AccountRow;
  site: SiteRow;
  token: AccountTokenRow | null;
};

export type MarketplaceModelAvailabilityResult = {
  success: true;
  available: boolean;
  modelName: string;
  accountId: number;
  accountName: string | null;
  siteId: number;
  siteName: string;
  latencyMs: number;
  reason: string;
  detectionMethod: 'model_list' | 'realtime_probe' | 'unknown';
  probeCheckedUrl: string | null;
  probeStatusCode: number | null;
  probeEndpoint: string | null;
  probeClassification: MarketplaceProbeClassification | null;
  autoKeyCreated: boolean;
  autoKeyName: string | null;
  autoKeyGroup: string | null;
  autoKeyTokenId: number | null;
  usedTokenId: number | null;
  usedTokenName: string | null;
};

export type MarketplaceModelAvailabilitySuccess = MarketplaceModelAvailabilityResult;

export type MarketplaceModelAvailabilityFailure = {
  success: false;
  available: false;
  modelName: string;
  accountId: number | null;
  accountName: string | null;
  siteId: number | null;
  siteName: string | null;
  latencyMs: number | null;
  error: string;
  message: string;
  autoKeyCreated: boolean;
  autoKeyName: string | null;
  autoKeyGroup: string | null;
  autoKeyTokenId: number | null;
};

export class MarketplaceModelProbeError extends Error {
  statusCode: number;
  payload: Record<string, unknown>;

  constructor(statusCode: number, payload: Record<string, unknown>, message?: string) {
    super(message || String(payload.message || payload.error || `HTTP ${statusCode}`));
    this.name = 'MarketplaceModelProbeError';
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function summarizeProbeError(rawText: string): string {
  const text = String(rawText || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as Record<string, any>;
    const nestedMessage = parsed?.error?.message || parsed?.message || parsed?.error || parsed?.detail;
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) return nestedMessage.trim();
  } catch {}
  return text.slice(0, 320);
}

export function classifyProbeFailureMessage(message: string): MarketplaceProbeClassification {
  const text = String(message || '').toLowerCase();
  if (!text) return 'inconclusive';
  if (
    /please use \/v1\/responses/i.test(text)
    || /use.*\/v1\/responses/i.test(text)
    || /messages is required for \/v1\/chat\/completions/i.test(text)
    || /anthropic-version/i.test(text)
    || /x-goog-api-key/i.test(text)
    || /generatecontent/i.test(text)
  ) {
    return 'protocol_mismatch';
  }
  if (
    /model.*(not found|does not exist|unsupported|invalid)/i.test(text)
    || /unknown model|no such model|unsupported model/i.test(text)
    || /模型.*(不存在|未找到|不支持|不可用)/i.test(text)
    || /当前分组不支持|未开通.*模型|not available for your/i.test(text)
  ) {
    return 'model_unavailable';
  }
  if (
    /unauthorized|forbidden|invalid api key|authentication|auth|apikey/i.test(text)
    || /no\s+(active|available|valid)\s+api\s*keys?/i.test(text)
    || /no\s+access\s+to\s+model/i.test(text)
    || /has\s+no\s+access\s+to\s+model/i.test(text)
    || /未授权|鉴权|权限|密钥|key 无效|token 无效|令牌|无效的令牌|无效的?key|token.*无效|key.*无效/i.test(text)
    || /无效的?token|令牌.*无效|token\s*(is\s*)?(invalid|expired|无效)/i.test(text)
  ) {
    return 'credential';
  }
  return 'inconclusive';
}

function resolveModelCredential(
  preferredCredential: string | null | undefined,
  preferredToken: AccountTokenRow | null,
  account: AccountRow,
  fallbackSiteApiKey: string,
): string {
  return (
    (preferredCredential || '').trim()
    || (preferredToken?.token || '').trim()
    || (account.apiToken || '').trim()
    || fallbackSiteApiKey
  );
}

function formatProbeReason(input: { listHit: boolean; probe: MarketplaceProbeResult | null }): string {
  if (!input.probe) {
    return input.listHit ? '模型已出现在上游列表中，但未完成实时探测' : '上游模型列表未包含该模型，且未完成实时探测';
  }

  const endpointLabel = input.probe.endpoint || 'auto';
  if (input.probe.available === true) {
    return `实时探测成功（${endpointLabel}）`;
  }
  if (input.probe.classification === 'model_unavailable') {
    return `上游已拒绝该模型（${endpointLabel}）：${input.probe.reason}`;
  }
  if (input.probe.classification === 'credential') {
    return `当前凭证无权访问该模型（${endpointLabel}）：${input.probe.reason}`;
  }
  if (input.probe.classification === 'protocol_mismatch') {
    return `该站点可能使用了不同的请求协议（${endpointLabel}）：${input.probe.reason}`;
  }
  const listPrefix = input.listHit ? '模型已在列表中，' : '';
  return `${listPrefix}实时探测未得出确定结论（${endpointLabel}）：${input.probe.reason}`;
}

function buildProbeEndpoints(platform: string): Array<'chat' | 'responses' | 'messages'> {
  const normalized = String(platform || '').trim().toLowerCase();
  if (normalized === 'claude') return ['messages', 'chat', 'responses'];
  return ['chat', 'responses', 'messages'];
}

function buildProbeRequest(baseUrl: string, modelName: string, endpoint: 'chat' | 'responses' | 'messages') {
  const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  // Use a realistic probe payload that can expose upstream overload/capacity issues.
  // A simple "ping" with max_tokens=1 passes even on severely overloaded upstreams,
  // giving false confidence.  A short but meaningful prompt with max_tokens=8 forces
  // the upstream to actually process and generate, catching 503/timeout errors early.
  const probePrompt = 'Respond with exactly one sentence describing the weather today.';
  if (endpoint === 'responses') {
    return {
      url: `${normalizedBase}/v1/responses`,
      body: {
        model: modelName,
        input: probePrompt,
        max_output_tokens: 8,
        temperature: 0,
      },
    };
  }
  if (endpoint === 'messages') {
    return {
      url: `${normalizedBase}/v1/messages`,
      body: {
        model: modelName,
        max_tokens: 8,
        messages: [{ role: 'user', content: probePrompt }],
      },
    };
  }
  return {
    url: `${normalizedBase}/v1/chat/completions`,
    body: {
      model: modelName,
      messages: [{ role: 'user', content: probePrompt }],
      max_tokens: 8,
      temperature: 0,
      stream: false,
    },
  };
}

function buildGeminiNativeProbeRequest(baseUrl: string, modelName: string) {
  const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  return {
    url: `${normalizedBase}/v1beta/models/${encodeURIComponent(modelName)}:generateContent`,
    body: {
      contents: [{ role: 'user', parts: [{ text: 'Respond with exactly one sentence describing the weather today.' }] }],
      generationConfig: { maxOutputTokens: 8, temperature: 0 },
    },
  };
}

function buildLocalProxyCanaryRequest(modelName: string) {
  return {
    url: `http://127.0.0.1:${config.port}/v1/chat/completions`,
    body: {
      model: modelName,
      messages: [{ role: 'user', content: 'Respond with exactly one sentence describing the weather today.' }],
      max_tokens: 8,
      temperature: 0,
      stream: false,
    },
  };
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasToolCallLike(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return false;
}

function isMeaningfulContentPartType(value: unknown): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return false;
  return normalized === 'tool_use'
    || normalized === 'tool_result'
    || normalized === 'thinking'
    || normalized === 'redacted_thinking'
    || normalized === 'reasoning'
    || normalized === 'refusal'
    || normalized.includes('function_call')
    || normalized.includes('tool_call');
}

function hasCompletionContentFromChoice(choice: any): boolean {
  if (hasNonEmptyString(choice?.text)) return true;
  if (hasNonEmptyString(choice?.completion)) return true;
  if (hasNonEmptyString(choice?.output_text)) return true;

  const message = choice?.message;
  if (hasNonEmptyString(message?.content)) return true;
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (hasNonEmptyString(part?.text) || hasNonEmptyString(part?.output_text) || hasNonEmptyString(part?.content)) {
        return true;
      }
      if (isMeaningfulContentPartType(part?.type)) return true;
    }
  }

  if (hasNonEmptyString(message?.refusal)) return true;
  if (hasToolCallLike(message?.tool_calls) || hasToolCallLike(message?.toolCalls)) return true;
  if (hasToolCallLike(message?.function_call) || hasToolCallLike(message?.functionCall)) return true;
  if (hasToolCallLike(choice?.tool_calls) || hasToolCallLike(choice?.toolCalls)) return true;
  if (hasToolCallLike(choice?.function_call) || hasToolCallLike(choice?.functionCall)) return true;

  const delta = choice?.delta;
  if (hasNonEmptyString(delta?.content) || hasNonEmptyString(delta?.refusal)) return true;
  if (hasToolCallLike(delta?.tool_calls) || hasToolCallLike(delta?.toolCalls)) return true;
  if (hasToolCallLike(delta?.function_call) || hasToolCallLike(delta?.functionCall)) return true;

  return false;
}

function hasCompletionContentFromPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const obj: any = payload;

  if (Array.isArray(obj?.candidates)) {
    for (const candidate of obj.candidates) {
      if (hasNonEmptyString(candidate?.text) || hasNonEmptyString(candidate?.output_text)) return true;
      if (Array.isArray(candidate?.content?.parts)) {
        for (const part of candidate.content.parts) {
          if (hasNonEmptyString(part?.text) || hasNonEmptyString(part?.output_text) || hasNonEmptyString(part?.content)) {
            return true;
          }
        }
      }
      if (Array.isArray(candidate?.content)) {
        for (const part of candidate.content) {
          if (hasNonEmptyString(part?.text) || hasNonEmptyString(part?.output_text) || hasNonEmptyString(part?.content)) {
            return true;
          }
        }
      }
    }
  }

  if (Array.isArray(obj?.choices)) {
    for (const choice of obj.choices) {
      if (hasCompletionContentFromChoice(choice)) return true;
    }
    if (hasCompletionContentFromChoice(obj)) return true;
  }

  if (hasNonEmptyString(obj?.output_text) || hasNonEmptyString(obj?.outputText)) return true;

  if (Array.isArray(obj?.output)) {
    for (const item of obj.output) {
      if (!isRecord(item)) continue;
      const type = String((item as any).type || '').toLowerCase();
      if (type.includes('function_call') || type.includes('tool_call')) return true;
      if (hasNonEmptyString((item as any).text) || hasNonEmptyString((item as any).output_text)) return true;
      if (Array.isArray((item as any).content)) {
        for (const part of (item as any).content) {
          if (hasNonEmptyString((part as any)?.text) || hasNonEmptyString((part as any)?.output_text) || hasNonEmptyString((part as any)?.content)) {
            return true;
          }
          if (isMeaningfulContentPartType((part as any)?.type)) return true;
        }
      }
      if (hasToolCallLike((item as any).tool_calls) || hasToolCallLike((item as any).toolCalls)) return true;
      if (hasToolCallLike((item as any).function_call) || hasToolCallLike((item as any).functionCall)) return true;
    }
  }

  if (Array.isArray(obj?.content)) {
    for (const part of obj.content) {
      if (hasNonEmptyString((part as any)?.text) || hasNonEmptyString((part as any)?.output_text) || hasNonEmptyString((part as any)?.content)) {
        return true;
      }
      if (isMeaningfulContentPartType((part as any)?.type)) return true;
    }
  }

  if (hasNonEmptyString(obj?.delta) || hasNonEmptyString(obj?.text)) return true;
  if (hasToolCallLike(obj?.tool_calls) || hasToolCallLike(obj?.toolCalls)) return true;
  if (hasToolCallLike(obj?.function_call) || hasToolCallLike(obj?.functionCall)) return true;

  return false;
}

function probeResponseHasOutput(rawText: string): boolean {
  const textValue = String(rawText || '');
  const trimmed = textValue.trim();
  if (!trimmed) return false;

  try {
    return hasCompletionContentFromPayload(JSON.parse(trimmed));
  } catch {
    const pulled = pullSseDataEvents(textValue);
    if (pulled.events.length > 0) {
      for (const event of pulled.events) {
        const payload = event.trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          if (hasCompletionContentFromPayload(JSON.parse(payload))) return true;
        } catch {
          return true;
        }
      }
      return false;
    }

    if (textValue.includes('data:')) return false;
    return true;
  }
}

export async function probeModelAvailabilityViaRealtimeCall(input: {
  baseUrl: string;
  platform: string;
  credential: string;
  modelName: string;
}): Promise<MarketplaceProbeResult> {
  const { fetch } = await import('undici');
  const endpointOrder = buildProbeEndpoints(input.platform);
  const attemptMessages: string[] = [];

  for (const endpoint of endpointOrder) {
    const probe = buildProbeRequest(input.baseUrl, input.modelName, endpoint);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json,text/event-stream,text/plain,*/*',
    };
    if (endpoint === 'messages') {
      headers['x-api-key'] = input.credential;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${input.credential}`;
    }

    try {
      const response = await fetch(
        probe.url,
        await withSiteProxyRequestInit(probe.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(probe.body),
          signal: AbortSignal.timeout(MARKETPLACE_MODEL_PROBE_TIMEOUT_MS),
        }),
      );

      const responseText = await response.text();

      if (response.ok) {
        if (probeResponseHasOutput(responseText)) {
          return {
            available: true,
            reason: `probe succeeded via ${endpoint} (HTTP ${response.status})`,
            checkedUrl: probe.url,
            statusCode: response.status,
            endpoint,
            classification: 'supported',
          };
        }

        attemptMessages.push(`${endpoint}:${response.status} empty content`);
        continue;
      }

      const summarized = summarizeProbeError(responseText) || `HTTP ${response.status}`;
      const classification = classifyProbeFailureMessage(summarized);
      if (classification === 'model_unavailable' || classification === 'credential') {
        return {
          available: false,
          reason: `probe rejected model via ${endpoint}: ${summarized}`,
          checkedUrl: probe.url,
          statusCode: response.status,
          endpoint,
          classification,
        };
      }

      attemptMessages.push(`${endpoint}:${response.status} ${summarized}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'unknown error');
      attemptMessages.push(`${endpoint}: ${message}`);
    }
  }

  const geminiProbe = buildGeminiNativeProbeRequest(input.baseUrl, input.modelName);
  try {
    const geminiResponse = await fetch(
      geminiProbe.url,
      await withSiteProxyRequestInit(geminiProbe.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json,text/plain,*/*',
          'x-goog-api-key': input.credential,
        },
        body: JSON.stringify(geminiProbe.body),
        signal: AbortSignal.timeout(MARKETPLACE_MODEL_PROBE_TIMEOUT_MS),
      }),
    );

    const geminiText = await geminiResponse.text();

    if (geminiResponse.ok) {
      if (probeResponseHasOutput(geminiText)) {
        return {
          available: true,
          reason: `probe succeeded via gemini-native (HTTP ${geminiResponse.status})`,
          checkedUrl: geminiProbe.url,
          statusCode: geminiResponse.status,
          endpoint: 'gemini-native',
          classification: 'supported',
        };
      }

      attemptMessages.push(`gemini-native:${geminiResponse.status} empty content`);
    } else {
      const geminiSummary = summarizeProbeError(geminiText) || `HTTP ${geminiResponse.status}`;
      const geminiClass = classifyProbeFailureMessage(geminiSummary);
      if (geminiClass === 'model_unavailable' || geminiClass === 'credential') {
        return {
          available: false,
          reason: `probe rejected model via gemini-native: ${geminiSummary}`,
          checkedUrl: geminiProbe.url,
          statusCode: geminiResponse.status,
          endpoint: 'gemini-native',
          classification: geminiClass,
        };
      }
      attemptMessages.push(`gemini-native:${geminiResponse.status} ${geminiSummary}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown error');
    attemptMessages.push(`gemini-native: ${message}`);
  }

  return {
    available: null,
    reason: attemptMessages[0] || 'probe inconclusive',
    checkedUrl: null,
    statusCode: null,
    endpoint: attemptMessages[0]?.split(':')[0] || null,
    classification: classifyProbeFailureMessage(attemptMessages[0] || ''),
  };
}

export async function probeModelAvailabilityViaLocalProxyCanary(input: {
  modelName: string;
  forcedChannelId?: number | null;
}): Promise<MarketplaceProbeResult> {
  const { fetch } = await import('undici');
  const probe = buildLocalProxyCanaryRequest(input.modelName);

  try {
    const response = await fetch(probe.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.proxyToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json,text/event-stream,text/plain,*/*',
        ...(typeof input.forcedChannelId === 'number' && input.forcedChannelId > 0
          ? {
            'x-metapi-tester-request': '1',
            'x-metapi-tester-forced-channel-id': String(input.forcedChannelId),
          }
          : {}),
      },
      body: JSON.stringify(probe.body),
      signal: AbortSignal.timeout(LOCAL_PROXY_CANARY_TIMEOUT_MS),
    });

    const responseText = await response.text();

    if (response.ok) {
      if (probeResponseHasOutput(responseText)) {
        return {
          available: true,
          reason: `probe succeeded via proxy-chat (HTTP ${response.status})`,
          checkedUrl: probe.url,
          statusCode: response.status,
          endpoint: 'proxy-chat',
          classification: 'supported',
        };
      }

      return {
        available: null,
        reason: 'proxy-chat:200 empty content',
        checkedUrl: probe.url,
        statusCode: response.status,
        endpoint: 'proxy-chat',
        classification: 'inconclusive',
      };
    }

    const summarized = summarizeProbeError(responseText) || `HTTP ${response.status}`;
    const classification = classifyProbeFailureMessage(summarized);
    return {
      available: classification === 'model_unavailable' || classification === 'credential' ? false : null,
      reason: `proxy-chat:${response.status} ${summarized}`,
      checkedUrl: probe.url,
      statusCode: response.status,
      endpoint: 'proxy-chat',
      classification,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown error');
    return {
      available: null,
      reason: `proxy-chat: ${message}`,
      checkedUrl: probe.url,
      statusCode: null,
      endpoint: 'proxy-chat',
      classification: classifyProbeFailureMessage(message),
    };
  }
}

function canonicalModelAlias(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  const slashIndex = normalized.indexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1);
  }
  return normalized;
}

function isModelAliasEquivalent(left: string, right: string): boolean {
  const a = canonicalModelAlias(left);
  const b = canonicalModelAlias(right);
  return !!a && !!b && a === b;
}

async function resolvePreferredTokenForCandidate(
  candidate: MarketplaceProbeCandidate,
  preferredTokenId?: number | null,
): Promise<AccountTokenRow | null> {
  if (typeof preferredTokenId === 'number' && Number.isFinite(preferredTokenId) && preferredTokenId > 0) {
    const token = await db.select().from(schema.accountTokens)
      .where(and(
        eq(schema.accountTokens.id, Math.trunc(preferredTokenId)),
        eq(schema.accountTokens.accountId, candidate.account.id),
      ))
      .get();
    if (token && isUsableAccountToken(token)) {
      return token;
    }
    // Preferred token is disabled/invalid or not found — fall back to account default
  }

  if (candidate.token && isUsableAccountToken(candidate.token)) {
    return candidate.token;
  }
  return await getPreferredAccountToken(candidate.account.id);
}

export async function resolveMarketplaceProbeCandidate(input: {
  modelName: string;
  accountId?: number | null;
  siteName?: string | null;
}): Promise<MarketplaceProbeCandidate> {
  // When accountId is explicitly provided, bypass modelAvailability.available pre-filter.
  // The purpose of probing is to *verify* availability — relying on potentially stale
  // modelAvailability records would make probes fail before even trying.
  if (input.accountId != null) {
    const accountRows = await db.select()
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.accounts.id, input.accountId),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();

    const filtered = accountRows
      .filter((row: typeof accountRows[number]) => (input.siteName ? row.sites.name === input.siteName : true));

    if (filtered.length === 0) {
      throw new MarketplaceModelProbeError(404, {
        success: false,
        error: 'no_available_account_for_model',
        message: 'no available account for this model',
        modelName: input.modelName,
      });
    }

    const targetRow = filtered[0]!;
    return {
      account: targetRow.accounts,
      site: targetRow.sites,
      token: null,
    };
  }

  // When no accountId is provided, use modelAvailability as the discovery filter
  const modelRows = await db.select()
    .from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.modelAvailability.modelName, input.modelName),
        eq(schema.modelAvailability.available, true),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  const candidateRows = modelRows
    .filter((row: typeof modelRows[number]) => (input.siteName ? row.sites.name === input.siteName : true));

  if (candidateRows.length === 0) {
    throw new MarketplaceModelProbeError(404, {
      success: false,
      error: 'no_available_account_for_model',
      message: 'no available account for this model',
      modelName: input.modelName,
    });
  }

  const targetRow = candidateRows[0]!;
  return {
    account: targetRow.accounts,
    site: targetRow.sites,
    token: null,
  };
}

export async function testMarketplaceModelAvailabilityForCandidate(input: {
  modelName: string;
  candidate: MarketplaceProbeCandidate;
  preferredTokenId?: number | null;
  useLocalProxyCanary?: boolean;
  proxyCanaryForcedChannelId?: number | null;
  preferredCredential?: string | null;
  allowAutoCreateKey?: boolean;
  forceRealtimeProbeOnListMiss?: boolean;
  allowListHitSuccess?: boolean;
}): Promise<MarketplaceModelAvailabilityResult> {
  const modelName = String(input.modelName || '').trim();
  if (!modelName) {
    throw new MarketplaceModelProbeError(400, {
      success: false,
      error: 'modelName is required',
      message: 'modelName is required',
    });
  }

  const { account, site } = input.candidate;
  const adapter = getAdapter(site.platform);
  if (!adapter) {
    throw new MarketplaceModelProbeError(400, {
      success: false,
      error: `unsupported platform: ${site.platform}`,
      message: `unsupported platform: ${site.platform}`,
      accountId: account.id,
      siteId: site.id,
      siteName: site.name,
    });
  }

  let preferredToken = await resolvePreferredTokenForCandidate(input.candidate, input.preferredTokenId);
  const fallbackSiteApiKey = (site.apiKey || '').trim();
  let modelCredential = resolveModelCredential(input.preferredCredential, preferredToken, account, fallbackSiteApiKey);
  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  const accountAccessToken = (account.accessToken || '').trim();
  const allowAutoCreateKey = input.allowAutoCreateKey !== false;
  let autoKeyCreated = false;
  let autoKeyName: string | null = null;
  let autoKeyGroup: string | null = null;
  let autoKeyTokenId: number | null = null;

  if (!modelCredential && allowAutoCreateKey && accountAccessToken) {
    try {
      const provision = await withTimeout(
        () => autoProvisionTokenCoverage({
          accountIds: [account.id],
          siteIds: [site.id],
          modelNames: [modelName],
        }, {
          provisionMode: 'scoped_model',
          refreshRouteChannels: false,
        }),
        MARKETPLACE_AUTO_KEY_TIMEOUT_MS,
        `auto provision timeout (${Math.round(MARKETPLACE_AUTO_KEY_TIMEOUT_MS / 1000)}s)`,
      );
      const createdItem = provision.results.find((item) => (
        item.status === 'created'
        || item.status === 'reused'
        || typeof item.createdTokenId === 'number'
        || !!item.createdTokenName
      )) || null;
      if (createdItem) {
        preferredToken = createdItem.createdTokenId
          ? await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, createdItem.createdTokenId)).get()
          : null;
        if (!preferredToken && createdItem.createdTokenName) {
          preferredToken = await db.select().from(schema.accountTokens)
            .where(and(
              eq(schema.accountTokens.accountId, account.id),
              eq(schema.accountTokens.name, createdItem.createdTokenName),
            ))
            .get();
        }
        if (!preferredToken) {
          preferredToken = await getPreferredAccountToken(account.id);
        }
        modelCredential = resolveModelCredential(input.preferredCredential, preferredToken, account, fallbackSiteApiKey);
        autoKeyCreated = !!modelCredential;
        autoKeyName = createdItem.createdTokenName || preferredToken?.name || null;
        autoKeyGroup = createdItem.createdTokenGroup || null;
        autoKeyTokenId = createdItem.createdTokenId || (typeof preferredToken?.id === 'number' ? preferredToken.id : null);

        if (!modelCredential) {
          try {
            const upstreamTokens = await withTimeout(
              () => adapter.getApiTokens(site.url, accountAccessToken, platformUserId),
              MARKETPLACE_AUTO_KEY_TIMEOUT_MS,
              `token sync timeout (${Math.round(MARKETPLACE_AUTO_KEY_TIMEOUT_MS / 1000)}s)`,
            );
            await syncTokensFromUpstream(account.id, upstreamTokens);
            preferredToken = await resolvePreferredTokenForCandidate(input.candidate, input.preferredTokenId);
            if (!preferredToken) {
              preferredToken = await getPreferredAccountToken(account.id);
            }
            modelCredential = resolveModelCredential(input.preferredCredential, preferredToken, account, fallbackSiteApiKey);
            autoKeyCreated = !!modelCredential;
            autoKeyName = autoKeyName || preferredToken?.name || null;
            autoKeyTokenId = autoKeyTokenId || (typeof preferredToken?.id === 'number' ? preferredToken.id : null);
          } catch {
            // Keep probe behavior conservative: fall through to the explicit credential error below.
          }
        }

        if (!modelCredential && createdItem.createdTokenName) {
          const upstreamToken = await withTimeout(
            () => adapter.getApiTokens(site.url, accountAccessToken, platformUserId),
            MARKETPLACE_AUTO_KEY_TIMEOUT_MS,
            `token lookup timeout (${Math.round(MARKETPLACE_AUTO_KEY_TIMEOUT_MS / 1000)}s)`,
          ).then((items) => (
            Array.isArray(items)
              ? items.find((item) => String(item?.name || '').trim() === createdItem.createdTokenName)
              : null
          )).catch(() => null);

          const upstreamTokenValue = String(upstreamToken?.key || '').trim();
          if (upstreamTokenValue) {
            const ensuredTokenId = await ensureDefaultTokenForAccount(account.id, upstreamTokenValue, {
              name: createdItem.createdTokenName,
              source: 'sync',
              enabled: upstreamToken?.enabled ?? true,
              tokenGroup: createdItem.createdTokenGroup || upstreamToken?.tokenGroup || null,
            });
            preferredToken = ensuredTokenId
              ? await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, ensuredTokenId)).get()
              : preferredToken;
            modelCredential = (
              (input.preferredCredential || '').trim()
              || upstreamTokenValue
              || (preferredToken?.token || '').trim()
              || (account.apiToken || '').trim()
              || fallbackSiteApiKey
            );
            autoKeyCreated = !!modelCredential;
            autoKeyName = autoKeyName || createdItem.createdTokenName || preferredToken?.name || null;
            autoKeyTokenId = autoKeyTokenId || ensuredTokenId || (typeof preferredToken?.id === 'number' ? preferredToken.id : null);
          }
        }
      }

      if (!modelCredential) {
        preferredToken = await resolvePreferredTokenForCandidate(input.candidate, input.preferredTokenId)
          .catch(() => null);
        if (!preferredToken) {
          preferredToken = await getPreferredAccountToken(account.id);
        }
        modelCredential = resolveModelCredential(input.preferredCredential, preferredToken, account, fallbackSiteApiKey);
        if (modelCredential) {
          autoKeyCreated = true;
          autoKeyName = autoKeyName || preferredToken?.name || null;
          autoKeyGroup = autoKeyGroup || preferredToken?.tokenGroup || null;
          autoKeyTokenId = autoKeyTokenId || (typeof preferredToken?.id === 'number' ? preferredToken.id : null);
        }
      }
    } catch {
      // Keep probe behavior conservative: fall through to the explicit credential error below.
    }
  }

  if (!modelCredential) {
    throw new MarketplaceModelProbeError(400, {
      success: false,
      available: false,
      error: 'site_missing_api_key',
      message: '站点未配置可用 API Key，请先创建 Key',
      modelName,
      accountId: account.id,
      siteId: site.id,
      siteName: site.name,
      autoCreateAttempted: allowAutoCreateKey && !!accountAccessToken,
      autoCreateSupported: !!accountAccessToken,
    });
  }

  const startedAt = Date.now();
  try {
    // Always probe with a real request to verify actual availability.
    // Model list check alone is insufficient — it only proves the model exists,
    // not that the credential has permission or the endpoint works correctly.
    let probeCheckedUrl: string | null = null;
    let probeStatusCode: number | null = null;
    let probeEndpoint: string | null = null;
    let probeClassification: MarketplaceProbeClassification | null = null;
    let available = false;
    let reason = '';
    let detectionMethod: MarketplaceModelAvailabilitySuccess['detectionMethod'] = 'unknown';

    // First, quickly check the model list for a cheaper pre-filter
    let listHit = false;
    try {
      const discoveredModels = await withTimeout(
        () => adapter.getModels(site.url, modelCredential, platformUserId),
        MARKETPLACE_MODEL_TEST_TIMEOUT_MS,
        `model list timeout`,
      );
      const normalizedSet = new Set(
        (Array.isArray(discoveredModels) ? discoveredModels : [])
          .map((item) => String(item || '').trim())
          .filter((item) => item.length > 0),
      );
      listHit = normalizedSet.has(modelName)
        || Array.from(normalizedSet).some((item) => isModelAliasEquivalent(item, modelName));
      if (listHit && input.allowListHitSuccess === true) {
        return {
          success: true,
          available: true,
          modelName,
          accountId: account.id,
          accountName: account.username || null,
          siteId: site.id,
          siteName: site.name,
          latencyMs: Date.now() - startedAt,
          reason: '模型已命中站点列表，按轻量探测策略视为可用',
          detectionMethod: 'model_list',
          probeCheckedUrl: null,
          probeStatusCode: null,
          probeEndpoint: null,
          probeClassification: 'supported',
          autoKeyCreated,
          autoKeyName,
          autoKeyGroup,
          autoKeyTokenId,
          usedTokenId: typeof preferredToken?.id === 'number' ? preferredToken.id : null,
          usedTokenName: preferredToken?.name || null,
        };
      }
      if (!listHit && input.forceRealtimeProbeOnListMiss !== true) {
        return {
          success: true,
          available: false,
          modelName,
          accountId: account.id,
          accountName: account.username || null,
          siteId: site.id,
          siteName: site.name,
          latencyMs: Date.now() - startedAt,
          reason: `模型 ${modelName} 不在站点可用模型列表中`,
          detectionMethod: 'model_list',
          probeCheckedUrl: null,
          probeStatusCode: null,
          probeEndpoint: null,
          probeClassification: 'model_unavailable',
          autoKeyCreated,
          autoKeyName,
          autoKeyGroup,
          autoKeyTokenId,
          usedTokenId: typeof preferredToken?.id === 'number' ? preferredToken.id : null,
          usedTokenName: preferredToken?.name || null,
        };
      }
    } catch {
      // Model list fetch failed — fall through to real probe
    }

    // Model is in the list — verify with a real request
    const shouldUseLocalProxyCanary = input.useLocalProxyCanary === true
      || (typeof input.proxyCanaryForcedChannelId === 'number' && input.proxyCanaryForcedChannelId > 0);
    const probe = shouldUseLocalProxyCanary
      ? await probeModelAvailabilityViaLocalProxyCanary({
        modelName,
        forcedChannelId: input.proxyCanaryForcedChannelId,
      })
      : await probeModelAvailabilityViaRealtimeCall({
        baseUrl: site.url,
        platform: site.platform,
        credential: modelCredential,
        modelName,
      });
    probeCheckedUrl = probe.checkedUrl;
    probeStatusCode = probe.statusCode;
    probeEndpoint = probe.endpoint;
    probeClassification = probe.classification;
    available = probe.available === true;
    reason = available
      ? `已通过真实验证确认可用 (list=${listHit}, probe=${probe.endpoint || 'ok'})`
      : formatProbeReason({ listHit, probe });
    detectionMethod = 'realtime_probe';

    return {
      success: true,
      available,
      modelName,
      accountId: account.id,
      accountName: account.username || null,
      siteId: site.id,
      siteName: site.name,
      latencyMs: Date.now() - startedAt,
      reason,
      detectionMethod,
      probeCheckedUrl,
      probeStatusCode,
      probeEndpoint,
      probeClassification,
      autoKeyCreated,
      autoKeyName,
      autoKeyGroup,
      autoKeyTokenId,
      usedTokenId: typeof preferredToken?.id === 'number' ? preferredToken.id : null,
      usedTokenName: preferredToken?.name || null,
    };
  } catch (error) {
    throw new MarketplaceModelProbeError(502, {
      success: false,
      available: false,
      modelName,
      accountId: account.id,
      accountName: account.username || null,
      siteId: site.id,
      siteName: site.name,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error || 'unknown error'),
      autoKeyCreated,
      autoKeyName,
      autoKeyGroup,
      autoKeyTokenId,
    });
  }
}

export async function testMarketplaceModelAvailability(input: {
  modelName: string;
  accountId?: number | null;
  siteName?: string | null;
  preferredTokenId?: number | null;
  useLocalProxyCanary?: boolean;
  proxyCanaryForcedChannelId?: number | null;
  preferredCredential?: string | null;
  allowAutoCreateKey?: boolean;
  forceRealtimeProbeOnListMiss?: boolean;
  allowListHitSuccess?: boolean;
}): Promise<MarketplaceModelAvailabilityResult> {
  const candidate = await resolveMarketplaceProbeCandidate({
    modelName: input.modelName,
    accountId: input.accountId,
    siteName: input.siteName,
  });
  return await testMarketplaceModelAvailabilityForCandidate({
    modelName: input.modelName,
    candidate,
    preferredTokenId: input.preferredTokenId,
    useLocalProxyCanary: input.useLocalProxyCanary,
    proxyCanaryForcedChannelId: input.proxyCanaryForcedChannelId,
    preferredCredential: input.preferredCredential,
    allowAutoCreateKey: input.allowAutoCreateKey,
    forceRealtimeProbeOnListMiss: input.forceRealtimeProbeOnListMiss,
    allowListHitSuccess: input.allowListHitSuccess,
  });
}

export async function probeMarketplaceModelAvailability(input: {
  modelName: string;
  accountId?: number | null;
  siteName?: string | null;
  preferredTokenId?: number | null;
  useLocalProxyCanary?: boolean;
  proxyCanaryForcedChannelId?: number | null;
  preferredCredential?: string | null;
  skipAutoCreate?: boolean;
  forceRealtimeProbeOnListMiss?: boolean;
  allowListHitSuccess?: boolean;
}): Promise<MarketplaceModelAvailabilitySuccess | MarketplaceModelAvailabilityFailure> {
  try {
    return await testMarketplaceModelAvailability({
      modelName: input.modelName,
      accountId: input.accountId,
      siteName: input.siteName,
      preferredTokenId: input.preferredTokenId,
      useLocalProxyCanary: input.useLocalProxyCanary,
      proxyCanaryForcedChannelId: input.proxyCanaryForcedChannelId,
      preferredCredential: input.preferredCredential,
      allowAutoCreateKey: input.skipAutoCreate !== true,
      forceRealtimeProbeOnListMiss: input.forceRealtimeProbeOnListMiss,
      allowListHitSuccess: input.allowListHitSuccess,
    });
  } catch (error) {
    if (error instanceof MarketplaceModelProbeError) {
      const payload = error.payload as Partial<MarketplaceModelAvailabilityFailure> & Record<string, unknown>;
      return {
        success: false,
        available: false,
        modelName: String(payload.modelName || input.modelName || ''),
        accountId: typeof payload.accountId === 'number' ? payload.accountId : (input.accountId ?? null),
        accountName: typeof payload.accountName === 'string' ? payload.accountName : null,
        siteId: typeof payload.siteId === 'number' ? payload.siteId : null,
        siteName: typeof payload.siteName === 'string' ? payload.siteName : null,
        latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : null,
        error: String(payload.error || error.message || 'unknown error'),
        message: String(payload.message || payload.error || error.message || 'unknown error'),
        autoKeyCreated: payload.autoKeyCreated === true,
        autoKeyName: typeof payload.autoKeyName === 'string' ? payload.autoKeyName : null,
        autoKeyGroup: typeof payload.autoKeyGroup === 'string' ? payload.autoKeyGroup : null,
        autoKeyTokenId: typeof payload.autoKeyTokenId === 'number' ? payload.autoKeyTokenId : null,
      };
    }
    return {
      success: false,
      available: false,
      modelName: input.modelName,
      accountId: input.accountId ?? null,
      accountName: null,
      siteId: null,
      siteName: input.siteName ?? null,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error || 'unknown error'),
      message: error instanceof Error ? error.message : String(error || 'unknown error'),
      autoKeyCreated: false,
      autoKeyName: null,
      autoKeyGroup: null,
      autoKeyTokenId: null,
    };
  }
}
