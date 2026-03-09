import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import {
  refreshModelsForAccount,
  refreshModelsAndRebuildRoutes,
  rebuildTokenRoutesFromAvailability,
} from '../../services/modelService.js';
import { getAdapter } from '../../services/platforms/index.js';
import { getPreferredAccountToken, syncTokensFromUpstream } from '../../services/accountTokenService.js';
import { resolvePlatformUserId } from '../../services/accountExtraConfig.js';
import { buildModelAnalysis } from '../../services/modelAnalysisService.js';
import { fallbackTokenCost, fetchModelPricingCatalog } from '../../services/modelPricingService.js';
import { withSiteProxyRequestInit } from '../../services/siteProxy.js';
import { getUpstreamModelDescriptionsCached } from '../../services/upstreamModelDescriptionService.js';
import { getRunningTaskByDedupeKey, startBackgroundTask } from '../../services/backgroundTaskService.js';
import { parseCheckinRewardAmount } from '../../services/checkinRewardParser.js';
import { estimateRewardWithTodayIncomeFallback } from '../../services/todayIncomeRewardService.js';
import {
  getProxyLogBaseSelectFields,
  parseProxyLogBillingDetails,
  withProxyLogSelectFields,
} from '../../services/proxyLogStore.js';
import {
  formatUtcSqlDateTime,
  getLocalDayRangeUtc,
  getLocalRangeStartUtc,
  toLocalDayKeyFromStoredUtc,
} from '../../services/localTimeService.js';

function parseBooleanFlag(raw?: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

const MODELS_MARKETPLACE_BASE_TTL_MS = 15_000;
const MODELS_MARKETPLACE_PRICING_TTL_MS = 90_000;
const MARKETPLACE_MODEL_TEST_TIMEOUT_MS = 15_000;
const MARKETPLACE_AUTO_KEY_TIMEOUT_MS = 8_000;
const MARKETPLACE_MODEL_PROBE_TIMEOUT_MS = 10_000;
const MARKETPLACE_MODEL_TEST_KEY_SCAN_LIMIT = 8;

type ModelsMarketplaceCacheEntry = {
  expiresAt: number;
  models: any[];
};

const modelsMarketplaceCache = new Map<'base' | 'pricing', ModelsMarketplaceCacheEntry>();

function readModelsMarketplaceCache(includePricing: boolean): any[] | null {
  const key = includePricing ? 'pricing' : 'base';
  const cached = modelsMarketplaceCache.get(key);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    modelsMarketplaceCache.delete(key);
    return null;
  }
  return cached.models;
}

function writeModelsMarketplaceCache(includePricing: boolean, models: any[]): void {
  const ttl = includePricing ? MODELS_MARKETPLACE_PRICING_TTL_MS : MODELS_MARKETPLACE_BASE_TTL_MS;
  const key = includePricing ? 'pricing' : 'base';
  modelsMarketplaceCache.set(key, {
    expiresAt: Date.now() + ttl,
    models,
  });
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

type MarketplaceProbeResult = {
  available: boolean | null;
  reason: string;
  checkedUrl: string | null;
  statusCode: number | null;
};

type MarketplaceProbeKind = 'text' | 'embeddings' | 'image' | 'video';

type MarketplaceProbeAttempt = {
  kind: MarketplaceProbeKind;
  label: string;
  responseType:
    | 'text-openai'
    | 'text-gemini'
    | 'embeddings-openai'
    | 'embeddings-gemini'
    | 'image-openai'
    | 'video-openai';
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const EMBEDDING_MODEL_PATTERNS = [
  /(?:^|[-_/])text-embedding/i,
  /embedding/i,
  /(?:^|[-_/])bge(?:$|[-_/])/i,
  /(?:^|[-_/])e5(?:$|[-_/])/i,
  /(?:^|[-_/])gte(?:$|[-_/])/i,
  /voyage/i,
  /jina[-_/]?embeddings?/i,
];

const IMAGE_MODEL_PATTERNS = [
  /imagen/i,
  /image-preview/i,
  /gpt-4o-image/i,
  /gpt-image/i,
  /flux/i,
  /midjourney/i,
  /qwen[-/.]?image/i,
  /z-image/i,
  /imagine/i,
  /cogview/i,
];

const IMAGE_NEGATIVE_PATTERNS = [
  /video/i,
  /veo/i,
  /sora/i,
  /cogvideo/i,
];

const VIDEO_MODEL_PATTERNS = [
  /video/i,
  /veo/i,
  /sora/i,
  /kling/i,
  /wan/i,
  /runway/i,
  /cogvideo/i,
];

const VIDEO_NEGATIVE_PATTERNS = [
  /image/i,
  /imagen/i,
  /flux/i,
  /midjourney/i,
  /cogview/i,
];

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

function parseProbeJson(rawText: string): any | null {
  const text = String(rawText || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractProbeErrorMessage(payload: any): string {
  if (!payload || typeof payload !== 'object') return '';
  const errorValue = payload.error;
  if (typeof errorValue === 'string' && errorValue.trim()) {
    return errorValue.trim().slice(0, 320);
  }
  if (errorValue && typeof errorValue === 'object') {
    const nested = errorValue.message || errorValue.msg || errorValue.detail || errorValue.error;
    if (typeof nested === 'string' && nested.trim()) {
      return nested.trim().slice(0, 320);
    }
  }
  const topLevel = payload.message || payload.detail;
  if (typeof topLevel === 'string' && topLevel.trim()) {
    return topLevel.trim().slice(0, 320);
  }
  return '';
}

function extractProbeModelName(payload: any): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.model,
    payload.response?.model,
    payload.data?.model,
    payload.meta?.model,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim();
    if (normalized) return normalized;
  }
  return null;
}

function classifyProbeFailureMessage(message: string): 'model_unavailable' | 'credential' | 'inconclusive' {
  const text = String(message || '').toLowerCase();
  if (!text) return 'inconclusive';
  if (
    /model.*(not found|does not exist|unsupported|invalid)/i.test(text)
    || /unknown model|no such model|unsupported model/i.test(text)
    || /模型.*(不存在|未找到|不支持|不可用)/i.test(text)
    || /当前分组不支持|未开通.*模型|not available for your/i.test(text)
    || /no available channel|under group|group .*distributor/i.test(text)
  ) {
    return 'model_unavailable';
  }
  if (
    /unauthorized|forbidden|invalid api key|authentication|auth|token|apikey/i.test(text)
    || /未授权|鉴权|权限|密钥|key 无效|token 无效/i.test(text)
  ) {
    return 'credential';
  }
  return 'inconclusive';
}

function normalizeProbeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function isVersionedBase(baseUrl: string): boolean {
  return /\/v\d+(?:beta)?(?:\.\d+)?(?:\/|$)/i.test(baseUrl);
}

function isOpenAiCompatGeminiBase(baseUrl: string): boolean {
  return /\/openai(?:\/|$)/i.test(baseUrl);
}

function buildOpenAiCompatibleUrl(baseUrl: string, path: string): string {
  const normalized = normalizeProbeBaseUrl(baseUrl);
  if (
    /(?:\/v\d+(?:beta)?(?:\.\d+)?(?:\/openai)?)$/i.test(normalized)
    || isOpenAiCompatGeminiBase(normalized)
  ) {
    return `${normalized}/${path}`;
  }
  return `${normalized}/v1/${path}`;
}

function buildAnthropicUrl(baseUrl: string, path: string): string {
  const normalized = normalizeProbeBaseUrl(baseUrl);
  if (/(?:\/v\d+(?:beta)?(?:\.\d+)?)$/i.test(normalized)) {
    return `${normalized}/${path}`;
  }
  return `${normalized}/v1/${path}`;
}

function buildGeminiNativeUrl(
  baseUrl: string,
  modelName: string,
  action: 'generateContent' | 'embedContent',
  credential: string,
): string {
  const normalized = normalizeProbeBaseUrl(baseUrl);
  const versionedBase = isVersionedBase(normalized) ? normalized : `${normalized}/v1beta`;
  return `${versionedBase}/models/${encodeURIComponent(modelName)}:${action}?key=${encodeURIComponent(credential)}`;
}

function normalizeProbeModelCandidates(modelName: string): string[] {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (!normalized) return [];
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return Array.from(new Set([normalized, normalized.slice(slashIndex + 1)]));
  }
  return [normalized];
}

function matchesProbePattern(modelName: string, patterns: RegExp[]): boolean {
  return normalizeProbeModelCandidates(modelName)
    .some((candidate) => patterns.some((pattern) => pattern.test(candidate)));
}

function inferProbeKindFromModelName(modelName: string): MarketplaceProbeKind | null {
  if (!modelName.trim()) return null;

  const isVideo = matchesProbePattern(modelName, VIDEO_MODEL_PATTERNS)
    && !matchesProbePattern(modelName, VIDEO_NEGATIVE_PATTERNS);
  if (isVideo) return 'video';

  const isImage = matchesProbePattern(modelName, IMAGE_MODEL_PATTERNS)
    && !matchesProbePattern(modelName, IMAGE_NEGATIVE_PATTERNS);
  if (isImage) return 'image';

  if (matchesProbePattern(modelName, EMBEDDING_MODEL_PATTERNS)) return 'embeddings';
  return null;
}

function inferProbeKindFromEndpointTypes(endpointTypes: string[]): MarketplaceProbeKind | null {
  const normalized = endpointTypes
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);

  if (normalized.some((item) => item.includes('/v1/embeddings') || item === 'embeddings')) {
    return 'embeddings';
  }
  if (normalized.some((item) => item.includes('/v1/videos') || item === 'videos' || item === 'video')) {
    return 'video';
  }
  if (
    normalized.some((item) =>
      item.includes('/v1/images')
      || item === 'images'
      || item === 'image_generation'
      || item === 'image-generation')
  ) {
    return 'image';
  }
  return null;
}

function getCachedMarketplaceEndpointTypes(modelName: string): string[] {
  const normalized = modelName.trim().toLowerCase();
  if (!normalized) return [];

  const pricingCache = readModelsMarketplaceCache(true);
  const matchedModel = Array.isArray(pricingCache)
    ? pricingCache.find((item) => String(item?.name || '').trim().toLowerCase() === normalized)
    : null;

  if (matchedModel && Array.isArray((matchedModel as any).supportedEndpointTypes)) {
    return (matchedModel as any).supportedEndpointTypes
      .map((item: unknown) => String(item || '').trim())
      .filter(Boolean);
  }

  return [];
}

function resolveMarketplaceProbeKind(modelName: string): MarketplaceProbeKind {
  const heuristicKind = inferProbeKindFromModelName(modelName);
  if (heuristicKind) return heuristicKind;

  const metadataKind = inferProbeKindFromEndpointTypes(getCachedMarketplaceEndpointTypes(modelName));
  if (metadataKind) return metadataKind;

  return 'text';
}

function buildTextProbeEndpoints(platform: string): Array<'chat' | 'responses' | 'messages'> {
  const normalized = String(platform || '').trim().toLowerCase();
  if (normalized === 'claude') return ['messages', 'chat', 'responses'];
  return ['chat', 'responses', 'messages'];
}

function buildTextProbeRequest(baseUrl: string, platform: string, modelName: string, endpoint: 'chat' | 'responses' | 'messages') {
  const normalizedBase = normalizeProbeBaseUrl(baseUrl);
  if (endpoint === 'responses') {
    return {
      url: buildOpenAiCompatibleUrl(normalizedBase, 'responses'),
      body: {
        model: modelName,
        input: 'ping',
        max_output_tokens: 1,
        temperature: 0,
      },
    };
  }
  if (endpoint === 'messages') {
    return {
      url: platform === 'claude'
        ? buildAnthropicUrl(normalizedBase, 'messages')
        : buildOpenAiCompatibleUrl(normalizedBase, 'messages'),
      body: {
        model: modelName,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      },
    };
  }
  return {
    url: buildOpenAiCompatibleUrl(normalizedBase, 'chat/completions'),
    body: {
      model: modelName,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      temperature: 0,
      stream: false,
    },
  };
}

function buildProbeAttempts(input: {
  baseUrl: string;
  platform: string;
  credential: string;
  modelName: string;
  kind: MarketplaceProbeKind;
}): MarketplaceProbeAttempt[] {
  const normalizedPlatform = String(input.platform || '').trim().toLowerCase();
  const normalizedBase = normalizeProbeBaseUrl(input.baseUrl);

  if (normalizedPlatform === 'gemini' && !isOpenAiCompatGeminiBase(normalizedBase)) {
    if (input.kind === 'embeddings') {
      return [{
        kind: input.kind,
        label: 'gemini.embedContent',
        responseType: 'embeddings-gemini',
        url: buildGeminiNativeUrl(normalizedBase, input.modelName, 'embedContent', input.credential),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: {
          model: `models/${input.modelName}`,
          content: {
            parts: [{ text: 'ping' }],
          },
        },
      }];
    }

    return [{
      kind: input.kind,
      label: 'gemini.generateContent',
      responseType: 'text-gemini',
      url: buildGeminiNativeUrl(normalizedBase, input.modelName, 'generateContent', input.credential),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: {
          maxOutputTokens: 1,
          temperature: 0,
        },
      },
    }];
  }

  if (input.kind === 'embeddings') {
    return [{
      kind: input.kind,
      label: 'embeddings',
      responseType: 'embeddings-openai',
      url: buildOpenAiCompatibleUrl(normalizedBase, 'embeddings'),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${input.credential}`,
      },
      body: {
        model: input.modelName,
        input: 'ping',
      },
    }];
  }

  if (input.kind === 'image') {
    return [{
      kind: input.kind,
      label: 'images',
      responseType: 'image-openai',
      url: buildOpenAiCompatibleUrl(normalizedBase, 'images/generations'),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${input.credential}`,
      },
      body: {
        model: input.modelName,
        prompt: 'ping',
        n: 1,
      },
    }];
  }

  if (input.kind === 'video') {
    return [{
      kind: input.kind,
      label: 'videos',
      responseType: 'video-openai',
      url: buildOpenAiCompatibleUrl(normalizedBase, 'videos'),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${input.credential}`,
      },
      body: {
        model: input.modelName,
        prompt: 'ping',
      },
    }];
  }

  return buildTextProbeEndpoints(input.platform).map((endpoint) => {
    const probe = buildTextProbeRequest(normalizedBase, normalizedPlatform, input.modelName, endpoint);
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

    return {
      kind: input.kind,
      label: endpoint,
      responseType: 'text-openai' as const,
      url: probe.url,
      headers,
      body: probe.body,
    };
  });
}

function evaluateSuccessfulProbePayload(
  attempt: MarketplaceProbeAttempt,
  payload: any,
  modelName: string,
): { available: boolean | null; reason?: string } {
  if (attempt.responseType === 'text-openai') {
    const returnedModel = extractProbeModelName(payload);
    if (!returnedModel) {
      return { available: null, reason: 'missing model in successful probe response' };
    }
    if (returnedModel !== modelName) {
      return {
        available: false,
        reason: `probe returned mismatched model via ${attempt.label}: expected ${modelName}, got ${returnedModel}`,
      };
    }
    return { available: true, reason: `probe succeeded via ${attempt.label}` };
  }

  if (attempt.responseType === 'text-gemini') {
    if (Array.isArray(payload?.candidates) && payload.candidates.length > 0) {
      return { available: true, reason: `probe succeeded via ${attempt.label}` };
    }
    if (payload?.promptFeedback || payload?.usageMetadata) {
      return { available: true, reason: `probe succeeded via ${attempt.label}` };
    }
    return { available: null, reason: 'missing candidates in successful Gemini probe response' };
  }

  if (attempt.responseType === 'embeddings-openai') {
    const returnedModel = extractProbeModelName(payload);
    if (returnedModel && returnedModel !== modelName) {
      return {
        available: false,
        reason: `probe returned mismatched model via ${attempt.label}: expected ${modelName}, got ${returnedModel}`,
      };
    }
    if (Array.isArray(payload?.data) && payload.data.length > 0) {
      return { available: true, reason: `probe succeeded via ${attempt.label}` };
    }
    return { available: null, reason: 'missing embeddings data in successful probe response' };
  }

  if (attempt.responseType === 'embeddings-gemini') {
    if (Array.isArray(payload?.embedding?.values) && payload.embedding.values.length > 0) {
      return { available: true, reason: `probe succeeded via ${attempt.label}` };
    }
    return { available: null, reason: 'missing embedding values in successful Gemini probe response' };
  }

  if (attempt.responseType === 'image-openai') {
    if (Array.isArray(payload?.data) && payload.data.length > 0) {
      return { available: true, reason: `probe succeeded via ${attempt.label}` };
    }
    if ((typeof payload?.id === 'string' && payload.id.trim()) || typeof payload?.created === 'number') {
      return { available: true, reason: `probe succeeded via ${attempt.label}` };
    }
    return { available: null, reason: 'missing generated image payload in successful probe response' };
  }

  if (
    (typeof payload?.id === 'string' && payload.id.trim())
    || (typeof payload?.status === 'string' && payload.status.trim())
    || payload?.object === 'video'
  ) {
    return { available: true, reason: `probe succeeded via ${attempt.label}` };
  }

  return { available: null, reason: 'missing video task payload in successful probe response' };
}

async function probeModelAvailabilityViaRealtimeCall(input: {
  baseUrl: string;
  platform: string;
  credential: string;
  modelName: string;
  kind: MarketplaceProbeKind;
}): Promise<MarketplaceProbeResult> {
  const { fetch } = await import('undici');
  const attempts = buildProbeAttempts(input);
  const attemptMessages: string[] = [];

  for (const attempt of attempts) {
    try {
      const response = await withTimeout(
        async () => {
          return await fetch(
            attempt.url,
            await withSiteProxyRequestInit(attempt.url, {
              method: 'POST',
              headers: attempt.headers,
              body: JSON.stringify(attempt.body),
              signal: AbortSignal.timeout(MARKETPLACE_MODEL_PROBE_TIMEOUT_MS),
            }),
          );
        },
        MARKETPLACE_MODEL_PROBE_TIMEOUT_MS + 500,
        `model probe timeout (${Math.round(MARKETPLACE_MODEL_PROBE_TIMEOUT_MS / 1000)}s)`,
      );

      if (response.ok) {
        const responseText = await response.text();
        const payload = parseProbeJson(responseText);
        if (!payload || typeof payload !== 'object') {
          attemptMessages.push(`${attempt.label}:${response.status} probe returned non-json success response`);
          continue;
        }

        const embeddedError = extractProbeErrorMessage(payload);
        if (embeddedError) {
          const classification = classifyProbeFailureMessage(embeddedError);
          if (classification === 'model_unavailable') {
            return {
              available: false,
              reason: `probe rejected model via ${attempt.label}: ${embeddedError}`,
              checkedUrl: attempt.url,
              statusCode: response.status,
            };
          }
          attemptMessages.push(`${attempt.label}:${response.status} ${embeddedError}`);
          continue;
        }

        const evaluated = evaluateSuccessfulProbePayload(attempt, payload, input.modelName);
        if (evaluated.available === false) {
          return {
            available: false,
            reason: evaluated.reason || `probe rejected model via ${attempt.label}`,
            checkedUrl: attempt.url,
            statusCode: response.status,
          };
        }
        if (evaluated.available === true) {
          return {
            available: true,
            reason: `${evaluated.reason || `probe succeeded via ${attempt.label}`} (HTTP ${response.status})`,
            checkedUrl: attempt.url,
            statusCode: response.status,
          };
        }
        attemptMessages.push(`${attempt.label}:${response.status} ${evaluated.reason || 'probe returned inconclusive success payload'}`);
        continue;
      }

      const responseText = await response.text();
      const summarized = summarizeProbeError(responseText) || `HTTP ${response.status}`;
      const classification = classifyProbeFailureMessage(summarized);
      if (classification === 'model_unavailable') {
        return {
          available: false,
          reason: `probe rejected model via ${attempt.label}: ${summarized}`,
          checkedUrl: attempt.url,
          statusCode: response.status,
        };
      }

      attemptMessages.push(`${attempt.label}:${response.status} ${summarized}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'unknown error');
      attemptMessages.push(`${attempt.label}: ${message}`);
    }
  }

  return {
    available: null,
    reason: attemptMessages[0] || 'probe inconclusive',
    checkedUrl: null,
    statusCode: null,
  };
}

function proxyCostSqlExpression() {
  return sql<number>`
    coalesce(
      ${schema.proxyLogs.estimatedCost},
      case
        when lower(coalesce(${schema.sites.platform}, 'new-api')) = 'veloera'
          then coalesce(${schema.proxyLogs.totalTokens}, 0) / 1000000.0
        else coalesce(${schema.proxyLogs.totalTokens}, 0) / 500000.0
      end
    )
  `;
}

export async function statsRoutes(app: FastifyInstance) {
  const proxyLogBaseFields = getProxyLogBaseSelectFields();

  // Dashboard summary
  app.get('/api/stats/dashboard', async () => {
    const accountRows = await db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .all();
    const accounts = accountRows.map((row) => row.accounts);
    const totalBalance = accounts.reduce((sum, a) => sum + (a.balance || 0), 0);
    const activeCount = accounts.filter((a) => a.status === 'active').length;

    const { localDay: today, startUtc: todayStartUtc, endUtc: todayEndUtc } = getLocalDayRangeUtc();
    const todayCheckinRows = await db.select().from(schema.checkinLogs)
      .innerJoin(schema.accounts, eq(schema.checkinLogs.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(
        gte(sql`datetime(${schema.checkinLogs.createdAt})`, todayStartUtc),
        lt(sql`datetime(${schema.checkinLogs.createdAt})`, todayEndUtc),
        eq(schema.sites.status, 'active'),
      ))
      .all();
    const todayCheckins = todayCheckinRows.map((row) => row.checkin_logs);
    const checkinFailed = todayCheckins.filter((c) => c.status === 'failed').length;
    const checkinSuccess = todayCheckins.length - checkinFailed;
    const rewardByAccount: Record<number, number> = {};
    const successCountByAccount: Record<number, number> = {};
    const parsedRewardCountByAccount: Record<number, number> = {};
    for (const row of todayCheckinRows) {
      const checkin = row.checkin_logs;
      if (checkin.status !== 'success') continue;
      const accountId = row.accounts.id;
      successCountByAccount[accountId] = (successCountByAccount[accountId] || 0) + 1;
      const rewardValue = parseCheckinRewardAmount(checkin.reward) || parseCheckinRewardAmount(checkin.message);
      if (rewardValue <= 0) continue;
      rewardByAccount[accountId] = (rewardByAccount[accountId] || 0) + rewardValue;
      parsedRewardCountByAccount[accountId] = (parsedRewardCountByAccount[accountId] || 0) + 1;
    }

    const nowTs = Date.now();
    const last24hDate = formatUtcSqlDateTime(new Date(nowTs - 86400000));
    const lastMinuteDate = formatUtcSqlDateTime(new Date(nowTs - 60_000));
    const last7dDate = getLocalRangeStartUtc(7);
    const recentProxyLogs = (await db.select({
      proxy_logs: proxyLogBaseFields,
      accounts: schema.accounts,
      sites: schema.sites,
    }).from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(gte(schema.proxyLogs.createdAt, last7dDate), eq(schema.sites.status, 'active')))
      .all())
      .map((row) => row.proxy_logs);
    const totalUsedRow = await db.select({
      totalUsed: sql<number>`coalesce(sum(${proxyCostSqlExpression()}), 0)`,
    })
      .from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .get();
    const proxy24hRow = await db.select({
      total: sql<number>`count(*)`,
      success: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
      failed: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'failed' then 1 else 0 end), 0)`,
      totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
    })
      .from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(gte(schema.proxyLogs.createdAt, last24hDate), eq(schema.sites.status, 'active')))
      .get();
    const proxyPerformanceRow = await db.select({
      total: sql<number>`count(*)`,
      totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
    })
      .from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(gte(schema.proxyLogs.createdAt, lastMinuteDate), eq(schema.sites.status, 'active')))
      .get();
    const todaySpendRow = await db.select({
      todaySpend: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.estimatedCost}, 0)), 0)`,
    })
      .from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(
        gte(sql`datetime(${schema.proxyLogs.createdAt})`, todayStartUtc),
        lt(sql`datetime(${schema.proxyLogs.createdAt})`, todayEndUtc),
        eq(schema.sites.status, 'active'),
      ))
      .get();

    const proxySuccess = Number(proxy24hRow?.success || 0);
    const proxyFailed = Number(proxy24hRow?.failed || 0);
    const proxyTotal = Number(proxy24hRow?.total || 0);
    const totalTokens = Number(proxy24hRow?.totalTokens || 0);
    const requestsPerMinute = Number(proxyPerformanceRow?.total || 0);
    const tokensPerMinute = Number(proxyPerformanceRow?.totalTokens || 0);
    const totalUsed = Number(totalUsedRow?.totalUsed || 0);
    const todaySpend = Number(todaySpendRow?.todaySpend || 0);
    const todayReward = accounts.reduce((sum, account) => sum + estimateRewardWithTodayIncomeFallback({
      day: today,
      successCount: successCountByAccount[account.id] || 0,
      parsedRewardCount: parsedRewardCountByAccount[account.id] || 0,
      rewardSum: rewardByAccount[account.id] || 0,
      extraConfig: account.extraConfig,
    }), 0);
    const modelAnalysis = buildModelAnalysis(recentProxyLogs, { days: 7 });

    return {
      totalBalance,
      totalUsed: Math.round(totalUsed * 1_000_000) / 1_000_000,
      todaySpend: Math.round(todaySpend * 1_000_000) / 1_000_000,
      todayReward: Math.round(todayReward * 1_000_000) / 1_000_000,
      activeAccounts: activeCount,
      totalAccounts: accounts.length,
      todayCheckin: { success: checkinSuccess, failed: checkinFailed, total: todayCheckins.length },
      proxy24h: { success: proxySuccess, failed: proxyFailed, total: proxyTotal, totalTokens },
      performance: {
        windowSeconds: 60,
        requestsPerMinute,
        tokensPerMinute,
      },
      modelAnalysis,
    };
  });

  // Proxy logs
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/stats/proxy-logs', async (request) => {
    const limit = parseInt(request.query.limit || '50', 10);
    const offset = parseInt(request.query.offset || '0', 10);
    const rows = await withProxyLogSelectFields(({ fields }) => (
      db.select({
        proxy_logs: fields,
        accounts: schema.accounts,
        sites: schema.sites,
      }).from(schema.proxyLogs)
        .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
        .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .orderBy(desc(schema.proxyLogs.createdAt))
        .limit(limit).offset(offset).all()
    ), { includeBillingDetails: true }) as Array<{
      proxy_logs: Record<string, unknown> & { billingDetails?: string | null };
      accounts: { username?: string | null } | null;
      sites: { name?: string | null; url?: string | null } | null;
    }>;

    return rows.map((row) => ({
      ...row.proxy_logs,
      billingDetails: parseProxyLogBillingDetails(row.proxy_logs.billingDetails),
      username: row.accounts?.username || null,
      siteName: row.sites?.name || null,
      siteUrl: row.sites?.url || null,
    }));
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/stats/proxy-video-tasks', async (request) => {
    const limit = parseInt(request.query.limit || '50', 10);
    const offset = parseInt(request.query.offset || '0', 10);
    const rows = await db.select({
      task: schema.proxyVideoTasks,
      accounts: schema.accounts,
      sites: schema.sites,
    }).from(schema.proxyVideoTasks)
      .leftJoin(schema.accounts, eq(schema.proxyVideoTasks.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .orderBy(desc(schema.proxyVideoTasks.createdAt))
      .limit(limit).offset(offset).all();

    return rows.map((row) => {
      const statusSnapshot = (() => {
        if (!row.task.statusSnapshot) return null;
        try {
          return JSON.parse(row.task.statusSnapshot);
        } catch {
          return null;
        }
      })();
      const upstreamResponseMeta = (() => {
        if (!row.task.upstreamResponseMeta) return null;
        try {
          return JSON.parse(row.task.upstreamResponseMeta);
        } catch {
          return null;
        }
      })();
      return {
        ...row.task,
        statusSnapshot,
        upstreamResponseMeta,
        username: row.accounts?.username || null,
        siteName: row.sites?.name || null,
        siteUrl: row.sites?.url || null,
      };
    });
  });

  // Models marketplace - refresh upstream models and aggregate.
  app.get<{ Querystring: { refresh?: string; includePricing?: string } }>('/api/models/marketplace', async (request) => {
    const refreshRequested = parseBooleanFlag(request.query.refresh);
    const includePricing = parseBooleanFlag(request.query.includePricing);

    let refreshQueued = false;
    let refreshReused = false;
    let refreshJobId: string | null = null;

    if (refreshRequested) {
      modelsMarketplaceCache.clear();
      const { task, reused } = startBackgroundTask(
        {
          type: 'model',
          title: '刷新模型广场数据',
          dedupeKey: 'refresh-models-and-rebuild-routes',
          notifyOnFailure: true,
          successMessage: (currentTask) => {
            const rebuild = (currentTask.result as any)?.rebuild;
            if (!rebuild) return '模型广场刷新已完成';
            return `模型广场刷新完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
          },
          failureMessage: (currentTask) => `模型广场刷新失败：${currentTask.error || 'unknown error'}`,
        },
        async () => refreshModelsAndRebuildRoutes(),
      );
      refreshQueued = !reused;
      refreshReused = reused;
      refreshJobId = task.id;
    }
    const runningRefreshTask = getRunningTaskByDedupeKey('refresh-models-and-rebuild-routes');
    if (!refreshJobId && runningRefreshTask) refreshJobId = runningRefreshTask.id;

    if (!refreshRequested) {
      const cachedModels = readModelsMarketplaceCache(includePricing);
      if (cachedModels) {
        return {
          models: cachedModels,
          meta: {
            refreshRequested,
            refreshQueued,
            refreshReused,
            refreshRunning: !!runningRefreshTask,
            refreshJobId,
            includePricing,
            cacheHit: true,
          },
        };
      }
    }

    const availability = await db.select().from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .all();
    const accountAvailability = await db.select().from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();

    const last7d = getLocalRangeStartUtc(7);
    const recentLogs = await db.select(proxyLogBaseFields).from(schema.proxyLogs)
      .where(gte(schema.proxyLogs.createdAt, last7d))
      .all();

    const modelLogStats: Record<string, { success: number; total: number; totalLatency: number }> = {};
    for (const log of recentLogs) {
      const model = log.modelActual || log.modelRequested || '';
      if (!modelLogStats[model]) modelLogStats[model] = { success: 0, total: 0, totalLatency: 0 };
      modelLogStats[model].total++;
      if (log.status === 'success') modelLogStats[model].success++;
      modelLogStats[model].totalLatency += log.latencyMs || 0;
    }

    type ModelMetadataAggregate = {
      description: string | null;
      tags: Set<string>;
      supportedEndpointTypes: Set<string>;
      pricingSources: Array<{
        siteId: number;
        siteName: string;
        accountId: number;
        username: string | null;
        ownerBy: string | null;
        enableGroups: string[];
        groupPricing: Record<string, {
          quotaType: number;
          inputPerMillion?: number;
          outputPerMillion?: number;
          perCallInput?: number;
          perCallOutput?: number;
          perCallTotal?: number;
        }>;
      }>;
    };

    const modelMetadataMap = new Map<string, ModelMetadataAggregate>();
    if (includePricing) {
      const activeAccountRows = await db.select().from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(and(eq(schema.accounts.status, 'active'), eq(schema.sites.status, 'active')))
        .all();

      const metadataResults = await Promise.all(activeAccountRows.map(async (row) => {
        const catalog = await fetchModelPricingCatalog({
          site: {
            id: row.sites.id,
            url: row.sites.url,
            platform: row.sites.platform,
          },
          account: {
            id: row.accounts.id,
            accessToken: row.accounts.accessToken,
            apiToken: row.accounts.apiToken,
          },
          modelName: '__metadata__',
          totalTokens: 0,
        });

        return {
          account: row.accounts,
          site: row.sites,
          catalog,
        };
      }));

      for (const result of metadataResults) {
        if (!result.catalog) continue;

        for (const model of result.catalog.models) {
          const key = model.modelName.toLowerCase();
          if (!modelMetadataMap.has(key)) {
            modelMetadataMap.set(key, {
              description: null,
              tags: new Set<string>(),
              supportedEndpointTypes: new Set<string>(),
              pricingSources: [],
            });
          }

          const aggregate = modelMetadataMap.get(key)!;
          if (!aggregate.description && model.modelDescription) {
            aggregate.description = model.modelDescription;
          }

          for (const tag of model.tags) aggregate.tags.add(tag);
          for (const endpointType of model.supportedEndpointTypes) {
            aggregate.supportedEndpointTypes.add(endpointType);
          }

          aggregate.pricingSources.push({
            siteId: result.site.id,
            siteName: result.site.name,
            accountId: result.account.id,
            username: result.account.username,
            ownerBy: model.ownerBy,
            enableGroups: model.enableGroups,
            groupPricing: model.groupPricing,
          });
        }
      }
    }

    const modelMap: Record<string, {
      name: string;
      accountsById: Map<number, {
        id: number;
        site: string;
        siteUrl: string | null;
        username: string | null;
        latency: number | null;
        unitCost: number | null;
        balance: number;
        tokens: Array<{ id: number; name: string; isDefault: boolean }>;
      }>;
    }> = {};

    for (const row of availability) {
      const m = row.token_model_availability;
      const t = row.account_tokens;
      const a = row.accounts;
      const s = row.sites;
      if (!m.available || !t.enabled || a.status !== 'active' || s.status !== 'active') continue;

      if (!modelMap[m.modelName]) {
        modelMap[m.modelName] = { name: m.modelName, accountsById: new Map() };
      }

      const existingAccount = modelMap[m.modelName].accountsById.get(a.id);
      if (!existingAccount) {
        modelMap[m.modelName].accountsById.set(a.id, {
          id: a.id,
          site: s.name,
          siteUrl: s.url,
          username: a.username,
          latency: m.latencyMs,
          unitCost: a.unitCost,
          balance: a.balance || 0,
          tokens: [{ id: t.id, name: t.name, isDefault: !!t.isDefault }],
        });
      } else {
        const nextLatency = (() => {
          if (existingAccount.latency == null) return m.latencyMs;
          if (m.latencyMs == null) return existingAccount.latency;
          return Math.min(existingAccount.latency, m.latencyMs);
        })();
        existingAccount.latency = nextLatency;
        if (!existingAccount.tokens.some((token) => token.id === t.id)) {
          existingAccount.tokens.push({ id: t.id, name: t.name, isDefault: !!t.isDefault });
        }
      }
    }

    for (const row of accountAvailability) {
      const m = row.model_availability;
      const a = row.accounts;
      const s = row.sites;
      if (!m.available || a.status !== 'active' || s.status !== 'active') continue;

      if (!modelMap[m.modelName]) {
        modelMap[m.modelName] = { name: m.modelName, accountsById: new Map() };
      }

      const existingAccount = modelMap[m.modelName].accountsById.get(a.id);
      if (!existingAccount) {
        modelMap[m.modelName].accountsById.set(a.id, {
          id: a.id,
          site: s.name,
          siteUrl: s.url,
          username: a.username,
          latency: m.latencyMs,
          unitCost: a.unitCost,
          balance: a.balance || 0,
          tokens: [],
        });
        continue;
      }

      const nextLatency = (() => {
        if (existingAccount.latency == null) return m.latencyMs;
        if (m.latencyMs == null) return existingAccount.latency;
        return Math.min(existingAccount.latency, m.latencyMs);
      })();
      existingAccount.latency = nextLatency;
    }

    let upstreamDescriptionMap = new Map<string, string>();
    if (includePricing) {
      const hasMissingDescription = Object.keys(modelMap).some((modelName) => {
        const metadata = modelMetadataMap.get(modelName.toLowerCase());
        return !metadata?.description;
      });
      if (hasMissingDescription) {
        upstreamDescriptionMap = await getUpstreamModelDescriptionsCached();
      }
    }

    const models = Object.values(modelMap).map((m) => {
      const logStats = modelLogStats[m.name];
      const accounts = Array.from(m.accountsById.values());
      const avgLatency = accounts.reduce((sum, a) => sum + (a.latency || 0), 0) / (accounts.length || 1);
      const metadata = modelMetadataMap.get(m.name.toLowerCase());
      const fallbackDescription = metadata?.description ? null : upstreamDescriptionMap.get(m.name.toLowerCase()) || null;
      return {
        name: m.name,
        accountCount: accounts.length,
        tokenCount: accounts.reduce((sum, account) => sum + account.tokens.length, 0),
        avgLatency: Math.round(avgLatency),
        successRate: logStats ? Math.round((logStats.success / logStats.total) * 1000) / 10 : null,
        description: metadata?.description || fallbackDescription,
        tags: metadata ? Array.from(metadata.tags).sort((a, b) => a.localeCompare(b)) : [],
        supportedEndpointTypes: metadata ? Array.from(metadata.supportedEndpointTypes).sort((a, b) => a.localeCompare(b)) : [],
        pricingSources: metadata?.pricingSources || [],
        accounts,
      };
    });

    models.sort((a, b) => b.accountCount - a.accountCount);
    writeModelsMarketplaceCache(includePricing, models);
    return {
      models,
      meta: {
        refreshRequested,
        refreshQueued,
        refreshReused,
        refreshRunning: !!runningRefreshTask,
        refreshJobId,
        includePricing,
      },
    };
  });

  app.get('/api/models/token-candidates', async () => {
    const resolveTokenGroupLabel = (tokenGroup: string | null, tokenName: string | null): string | null => {
      const explicit = (tokenGroup || '').trim();
      if (explicit) return explicit;

      const name = (tokenName || '').trim();
      if (!name) return null;
      const normalized = name.toLowerCase();
      if (normalized === 'default' || normalized === '默认' || /^default($|[-_\s])/.test(normalized)) {
        return 'default';
      }
      if (/^token-\d+$/.test(normalized)) return null;
      return name;
    };

    const rows = await db.select().from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.tokenModelAvailability.available, true),
          eq(schema.accountTokens.enabled, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();
    const availableModelRows = await db.select({
      modelName: schema.modelAvailability.modelName,
      accountId: schema.accounts.id,
      username: schema.accounts.username,
      siteId: schema.sites.id,
      siteName: schema.sites.name,
    })
      .from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();

    const result: Record<string, Array<{
      accountId: number;
      tokenId: number;
      tokenName: string;
      isDefault: boolean;
      username: string | null;
      siteId: number;
      siteName: string;
    }>> = {};
    const coveredAccountModelSet = new Set<string>();
    const coveredGroupsByAccountModel = new Map<string, Map<string, string>>();
    const unknownGroupCoverageByAccountModel = new Set<string>();
    const modelsWithoutToken: Record<string, Array<{
      accountId: number;
      username: string | null;
      siteId: number;
      siteName: string;
    }>> = {};
    const modelsMissingTokenGroups: Record<string, Array<{
      accountId: number;
      username: string | null;
      siteId: number;
      siteName: string;
      missingGroups: string[];
      requiredGroups: string[];
      availableGroups: string[];
      groupCoverageUncertain?: boolean;
    }>> = {};
    let hasAnyTokenGroupSignals = false;

    for (const row of rows) {
      const modelName = (row.token_model_availability.modelName || '').trim();
      if (!modelName) continue;
      const accountModelKey = `${row.accounts.id}::${modelName.toLowerCase()}`;
      coveredAccountModelSet.add(accountModelKey);

      const resolvedTokenGroup = resolveTokenGroupLabel(row.account_tokens.tokenGroup, row.account_tokens.name);
      if (resolvedTokenGroup) {
        hasAnyTokenGroupSignals = true;
        if (!coveredGroupsByAccountModel.has(accountModelKey)) {
          coveredGroupsByAccountModel.set(accountModelKey, new Map<string, string>());
        }
        const groupKey = resolvedTokenGroup.toLowerCase();
        if (!coveredGroupsByAccountModel.get(accountModelKey)!.has(groupKey)) {
          coveredGroupsByAccountModel.get(accountModelKey)!.set(groupKey, resolvedTokenGroup);
        }
      } else {
        unknownGroupCoverageByAccountModel.add(accountModelKey);
      }

      if (!result[modelName]) result[modelName] = [];
      if (result[modelName].some((item) => item.tokenId === row.account_tokens.id)) continue;
      result[modelName].push({
        accountId: row.accounts.id,
        tokenId: row.account_tokens.id,
        tokenName: row.account_tokens.name,
        isDefault: !!row.account_tokens.isDefault,
        username: row.accounts.username,
        siteId: row.sites.id,
        siteName: row.sites.name,
      });
    }

    for (const row of availableModelRows) {
      const modelName = (row.modelName || '').trim();
      if (!modelName) continue;
      const coverageKey = `${row.accountId}::${modelName.toLowerCase()}`;
      if (coveredAccountModelSet.has(coverageKey)) continue;
      if (!modelsWithoutToken[modelName]) modelsWithoutToken[modelName] = [];
      if (modelsWithoutToken[modelName].some((item) => item.accountId === row.accountId)) continue;
      modelsWithoutToken[modelName].push({
        accountId: row.accountId,
        username: row.username,
        siteId: row.siteId,
        siteName: row.siteName,
      });
    }

    const accountIdsForGroupHints = new Set(availableModelRows.map((row) => row.accountId));
    const requiredGroupsByAccountModel = new Map<string, Map<string, string>>();
    const hasPotentialGroupHints = hasAnyTokenGroupSignals || unknownGroupCoverageByAccountModel.size > 0;

    if (hasPotentialGroupHints && accountIdsForGroupHints.size > 0) {
      const accountRows = await db.select().from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.accounts.status, 'active'),
            eq(schema.sites.status, 'active'),
          ),
        )
        .all();

      const metadataResults = await Promise.all(
        accountRows
          .filter((row) => accountIdsForGroupHints.has(row.accounts.id))
          .map(async (row) => {
            try {
              const catalog = await fetchModelPricingCatalog({
                site: {
                  id: row.sites.id,
                  url: row.sites.url,
                  platform: row.sites.platform,
                },
                account: {
                  id: row.accounts.id,
                  accessToken: row.accounts.accessToken,
                  apiToken: row.accounts.apiToken,
                },
                modelName: '__metadata__',
                totalTokens: 0,
              });
              return { accountId: row.accounts.id, catalog };
            } catch {
              return { accountId: row.accounts.id, catalog: null as Awaited<ReturnType<typeof fetchModelPricingCatalog>> };
            }
          }),
      );

      for (const result of metadataResults) {
        if (!result.catalog) continue;
        for (const model of result.catalog.models) {
          const modelName = (model.modelName || '').trim();
          if (!modelName) continue;
          const groups = new Map<string, string>();
          for (const rawGroup of model.enableGroups || []) {
            const group = String(rawGroup || '').trim();
            if (!group) continue;
            const groupKey = group.toLowerCase();
            if (!groups.has(groupKey)) groups.set(groupKey, group);
          }
          if (groups.size === 0) continue;
          requiredGroupsByAccountModel.set(`${result.accountId}::${modelName.toLowerCase()}`, groups);
        }
      }
    }

    for (const row of availableModelRows) {
      const modelName = (row.modelName || '').trim();
      if (!modelName) continue;
      const accountModelKey = `${row.accountId}::${modelName.toLowerCase()}`;

      const requiredGroups = requiredGroupsByAccountModel.get(accountModelKey);
      if (!requiredGroups || requiredGroups.size === 0) continue;

      const availableGroups = coveredGroupsByAccountModel.get(accountModelKey) || new Map<string, string>();
      const missingGroups = Array.from(requiredGroups.entries())
        .filter(([groupKey]) => !availableGroups.has(groupKey))
        .map(([, label]) => label);
      if (missingGroups.length === 0) continue;

      if (!modelsMissingTokenGroups[modelName]) modelsMissingTokenGroups[modelName] = [];
      if (modelsMissingTokenGroups[modelName].some((item) => item.accountId === row.accountId)) continue;
      const hintRow = {
        accountId: row.accountId,
        username: row.username,
        siteId: row.siteId,
        siteName: row.siteName,
        missingGroups: missingGroups.sort((a, b) => a.localeCompare(b)),
        requiredGroups: Array.from(requiredGroups.values()).sort((a, b) => a.localeCompare(b)),
        availableGroups: Array.from(availableGroups.values()).sort((a, b) => a.localeCompare(b)),
      } as {
        accountId: number;
        username: string | null;
        siteId: number;
        siteName: string;
        missingGroups: string[];
        requiredGroups: string[];
        availableGroups: string[];
        groupCoverageUncertain?: boolean;
      };
      if (unknownGroupCoverageByAccountModel.has(accountModelKey)) {
        hintRow.groupCoverageUncertain = true;
      }
      modelsMissingTokenGroups[modelName].push(hintRow);
    }

    const endpointTypesByModel: Record<string, string[]> = {};
    const cachedPricing = readModelsMarketplaceCache(true);
    const cachedBase = cachedPricing || readModelsMarketplaceCache(false);
    if (cachedBase) {
      for (const model of cachedBase) {
        if (Array.isArray(model.supportedEndpointTypes) && model.supportedEndpointTypes.length > 0) {
          endpointTypesByModel[model.name] = model.supportedEndpointTypes;
        }
      }
    }

    return {
      models: result,
      modelsWithoutToken,
      modelsMissingTokenGroups,
      endpointTypesByModel,
    };
  });

  // Refresh models for one account and rebuild routes.
  app.post<{ Params: { accountId: string } }>('/api/models/check/:accountId', async (request) => {
    const accountId = Number.parseInt(request.params.accountId, 10);
    if (Number.isNaN(accountId)) {
      return { success: false, error: 'Invalid account id' };
    }

    const refresh = await refreshModelsForAccount(accountId);
    const rebuild = rebuildTokenRoutesFromAvailability();
    return { success: true, refresh, rebuild };
  });

  app.post<{ Body?: { modelName?: string; accountId?: number; siteName?: string } }>('/api/models/marketplace/test', async (request, reply) => {
    const modelName = String(request.body?.modelName || '').trim();
    if (!modelName) {
      return reply.code(400).send({ success: false, error: 'modelName is required' });
    }

    const accountIdInput = request.body?.accountId;
    const accountId = Number.isFinite(accountIdInput) ? Number(accountIdInput) : null;
    const siteName = String(request.body?.siteName || '').trim();

    const modelRows = await db.select()
      .from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.modelAvailability.modelName, modelName),
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();

    const candidateRows = modelRows
      .filter((row) => (accountId == null ? true : row.accounts.id === accountId))
      .filter((row) => (siteName ? row.sites.name === siteName : true));

    if (candidateRows.length === 0) {
      return reply.code(404).send({
        success: false,
        error: 'no available account for this model',
      });
    }

    const targetRow = candidateRows[0];
    const account = targetRow.accounts;
    const site = targetRow.sites;
    const adapter = getAdapter(site.platform);
    if (!adapter) {
      return reply.code(400).send({
        success: false,
        error: `unsupported platform: ${site.platform}`,
      });
    }

    const enabledTokens = await db.select()
      .from(schema.accountTokens)
      .where(and(eq(schema.accountTokens.accountId, account.id), eq(schema.accountTokens.enabled, true)))
      .all();

    let preferredToken = await getPreferredAccountToken(account.id);
    const fallbackSiteApiKey = (site.apiKey || '').trim();
    const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
    const accountAccessToken = (account.accessToken || '').trim();
    let autoKeyCreated = false;
    let autoKeyName: string | null = null;
    let autoKeyGroup: string | null = null;
    let autoCreateAttempted = false;

    const credentialCandidates: Array<{ credential: string; source: string }> = [];
    const pushCredentialCandidate = (credentialRaw: string | null | undefined, source: string) => {
      const credential = String(credentialRaw || '').trim();
      if (!credential) return;
      if (credentialCandidates.some((item) => item.credential === credential)) return;
      credentialCandidates.push({ credential, source });
    };

    pushCredentialCandidate(preferredToken?.token, `default:${preferredToken?.name || preferredToken?.id || 'token'}`);
    pushCredentialCandidate(account.apiToken, 'account_api_token');
    for (const token of enabledTokens) {
      pushCredentialCandidate(token.token, `token:${token.name || token.id}`);
    }
    pushCredentialCandidate(fallbackSiteApiKey, 'site_api_key');

    const tryCreateModelScopedKey = async (): Promise<string | null> => {
      if (!accountAccessToken) return null;
      autoCreateAttempted = true;
      try {
        const groups = await withTimeout(
          () => adapter.getUserGroups(site.url, accountAccessToken, platformUserId),
          MARKETPLACE_AUTO_KEY_TIMEOUT_MS,
          `list groups timeout (${Math.round(MARKETPLACE_AUTO_KEY_TIMEOUT_MS / 1000)}s)`,
        );
        const targetGroup = String(groups.find((item) => String(item || '').trim().length > 0) || 'default').trim() || 'default';
        const safeModelPart = modelName.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 32) || 'model';
        const generatedName = `metapi-auto-${safeModelPart}-${Date.now().toString().slice(-6)}`;
        const created = await withTimeout(
          () => adapter.createApiToken(site.url, accountAccessToken, platformUserId, {
            name: generatedName,
            group: targetGroup,
            modelLimitsEnabled: true,
            modelLimits: modelName,
          }),
          MARKETPLACE_AUTO_KEY_TIMEOUT_MS,
          `create api key timeout (${Math.round(MARKETPLACE_AUTO_KEY_TIMEOUT_MS / 1000)}s)`,
        );
        if (created) {
          const upstreamTokens = await withTimeout(
            () => adapter.getApiTokens(site.url, accountAccessToken, platformUserId),
            MARKETPLACE_AUTO_KEY_TIMEOUT_MS,
            `list api keys timeout (${Math.round(MARKETPLACE_AUTO_KEY_TIMEOUT_MS / 1000)}s)`,
          );
          await syncTokensFromUpstream(account.id, upstreamTokens);
          preferredToken = await getPreferredAccountToken(account.id);
          const createdToken = upstreamTokens.find((token) => String(token.name || '').trim() === generatedName);
          const createdCredential = (
            (createdToken?.key || '').trim()
            || (preferredToken?.token || '').trim()
          );
          if (createdCredential) {
            autoKeyCreated = true;
            autoKeyName = generatedName;
            autoKeyGroup = targetGroup;
            pushCredentialCandidate(createdCredential, `auto:${generatedName}`);
            return createdCredential;
          }
        }
      } catch {
        // Keep conservative behavior: fall through to explicit hint below.
      }
      return null;
    };

    if (credentialCandidates.length === 0) {
      await tryCreateModelScopedKey();
    }

    if (credentialCandidates.length === 0) {
      return reply.code(400).send({
        success: false,
        error: 'site_missing_api_key',
        message: '站点未配置可用 API Key，请先创建 Key',
        accountId: account.id,
        siteId: site.id,
        siteName: site.name,
        autoCreateAttempted,
        autoCreateSupported: !!accountAccessToken,
      });
    }

    const startedAt = Date.now();
    try {
      const probeKind = resolveMarketplaceProbeKind(modelName);

      const checkCredentialAvailability = async (credential: string): Promise<{
        available: boolean;
        reason: string;
        probeCheckedUrl: string | null;
        probeStatusCode: number | null;
      }> => {
        const discoveredModels = await withTimeout(
          () => adapter.getModels(site.url, credential, platformUserId),
          MARKETPLACE_MODEL_TEST_TIMEOUT_MS,
          `model test timeout (${Math.round(MARKETPLACE_MODEL_TEST_TIMEOUT_MS / 1000)}s)`,
        );
        const normalizedSet = new Set(
          (Array.isArray(discoveredModels) ? discoveredModels : [])
            .map((item) => String(item || '').trim())
            .filter((item) => item.length > 0),
        );
        const listedInUpstream = normalizedSet.has(modelName);
        const listReason = listedInUpstream ? 'model found in upstream list' : 'model not found in upstream list';

        const probe = await probeModelAvailabilityViaRealtimeCall({
          baseUrl: site.url,
          platform: site.platform,
          credential,
          modelName,
          kind: probeKind,
        });
        const probeCheckedUrl = probe.checkedUrl;
        const probeStatusCode = probe.statusCode;
        if (probe.available === true) {
          return {
            available: true,
            reason: `${listReason}; model accepted by realtime probe: ${probe.reason}`,
            probeCheckedUrl,
            probeStatusCode,
          };
        }
        if (probe.available === false) {
          return {
            available: false,
            reason: `${listReason}; ${probe.reason}`,
            probeCheckedUrl,
            probeStatusCode,
          };
        }

        return {
          available: false,
          reason: `${listReason}; probe inconclusive: ${probe.reason}`,
          probeCheckedUrl,
          probeStatusCode,
        };
      };

      let available = false;
      let reason = 'model not found in upstream list';
      let probeCheckedUrl: string | null = null;
      let probeStatusCode: number | null = null;
      let usedApiKey: string | null = null;
      let usedApiKeySource: string | null = null;
      let checkedCredentialCount = 0;
      const checkedCredentialSet = new Set<string>();

      for (const candidate of credentialCandidates.slice(0, MARKETPLACE_MODEL_TEST_KEY_SCAN_LIMIT)) {
        checkedCredentialSet.add(candidate.credential);
        checkedCredentialCount++;
        const result = await checkCredentialAvailability(candidate.credential);
        usedApiKey = candidate.credential;
        usedApiKeySource = candidate.source;
        reason = result.reason;
        probeCheckedUrl = result.probeCheckedUrl;
        probeStatusCode = result.probeStatusCode;
        if (result.available) {
          available = true;
          break;
        }
      }

      if (!available && accountAccessToken && !autoKeyCreated) {
        const createdCredential = await tryCreateModelScopedKey();
        if (createdCredential && !checkedCredentialSet.has(createdCredential)) {
          checkedCredentialCount++;
          const result = await checkCredentialAvailability(createdCredential);
          usedApiKey = createdCredential;
          usedApiKeySource = autoKeyName ? `auto:${autoKeyName}` : 'auto_created';
          reason = result.reason;
          probeCheckedUrl = result.probeCheckedUrl;
          probeStatusCode = result.probeStatusCode;
          available = result.available;
        }
      }

      if (!available && credentialCandidates.length > MARKETPLACE_MODEL_TEST_KEY_SCAN_LIMIT) {
        reason = `${reason}; scanned ${MARKETPLACE_MODEL_TEST_KEY_SCAN_LIMIT}/${credentialCandidates.length} keys`;
      }

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
        probeCheckedUrl,
        probeStatusCode,
        usedApiKey,
        usedApiKeySource,
        checkedCredentialCount,
        autoKeyCreated,
        autoKeyName,
        autoKeyGroup,
      };
    } catch (error) {
      return reply.code(502).send({
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
      });
    }
  });

  // Site distribution – per-site aggregate data
  app.get('/api/stats/site-distribution', async () => {
    const accountRows = await db.select({
      siteId: schema.sites.id,
      siteName: schema.sites.name,
      platform: schema.sites.platform,
      totalBalance: sql<number>`coalesce(sum(coalesce(${schema.accounts.balance}, 0)), 0)`,
      accountCount: sql<number>`count(*)`,
    })
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .groupBy(schema.sites.id, schema.sites.name, schema.sites.platform)
      .all();

    const spendRows = await db.select({
      siteId: schema.sites.id,
      totalSpend: sql<number>`coalesce(sum(${proxyCostSqlExpression()}), 0)`,
    })
      .from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .groupBy(schema.sites.id)
      .all();

    const spendBySiteId = new Map<number, number>();
    for (const row of spendRows) {
      if (row.siteId == null) continue;
      spendBySiteId.set(row.siteId, Number(row.totalSpend || 0));
    }

    const distribution = accountRows.map((row) => ({
      siteId: row.siteId,
      siteName: row.siteName,
      platform: row.platform,
      totalBalance: Math.round(Number(row.totalBalance || 0) * 1_000_000) / 1_000_000,
      totalSpend: Math.round((spendBySiteId.get(row.siteId) || 0) * 1_000_000) / 1_000_000,
      accountCount: Number(row.accountCount || 0),
    }));

    return { distribution };
  });

  // Site trend – daily spend/calls broken down by site
  app.get<{ Querystring: { days?: string } }>('/api/stats/site-trend', async (request) => {
    const days = Math.max(1, parseInt(request.query.days || '7', 10));
    const sinceDate = getLocalRangeStartUtc(days);

    const rows = await db.select({
      proxy_logs: proxyLogBaseFields,
      accounts: schema.accounts,
      sites: schema.sites,
    }).from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(gte(schema.proxyLogs.createdAt, sinceDate), eq(schema.sites.status, 'active')))
      .all();

    // Group by date + site name
    const dayMap: Record<string, Record<string, { spend: number; calls: number }>> = {};

    for (const row of rows) {
      const log = row.proxy_logs;
      const siteName = row.sites?.name || 'unknown';
      const platform = row.sites?.platform || 'new-api';
      const date = toLocalDayKeyFromStoredUtc(log.createdAt);
      if (!date) continue;

      if (!dayMap[date]) dayMap[date] = {};
      if (!dayMap[date][siteName]) dayMap[date][siteName] = { spend: 0, calls: 0 };

      const explicitCost = typeof log.estimatedCost === 'number' ? log.estimatedCost : 0;
      const cost = explicitCost > 0 ? explicitCost : fallbackTokenCost(log.totalTokens || 0, platform);
      dayMap[date][siteName].spend += cost;
      dayMap[date][siteName].calls++;
    }

    // Round spend values and sort by date
    const trend = Object.entries(dayMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, sites]) => {
        const rounded: Record<string, { spend: number; calls: number }> = {};
        for (const [name, stats] of Object.entries(sites)) {
          rounded[name] = {
            spend: Math.round(stats.spend * 1_000_000) / 1_000_000,
            calls: stats.calls,
          };
        }
        return { date, sites: rounded };
      });

    return { trend };
  });

  // Model stats by site
  app.get<{ Querystring: { siteId?: string; days?: string } }>('/api/stats/model-by-site', async (request) => {
    const siteId = request.query.siteId ? parseInt(request.query.siteId, 10) : null;
    const days = Math.max(1, parseInt(request.query.days || '7', 10));
    const sinceDate = getLocalRangeStartUtc(days);

    // Get account IDs belonging to the site (if filtered)
    let accountIds: Set<number> | null = null;
    if (siteId != null && !Number.isNaN(siteId)) {
      const siteAccounts = await db.select().from(schema.accounts)
        .where(eq(schema.accounts.siteId, siteId)).all();
      accountIds = new Set(siteAccounts.map((a) => a.id));
    }

    const rows = await db.select({
      proxy_logs: proxyLogBaseFields,
      accounts: schema.accounts,
      sites: schema.sites,
    }).from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(gte(schema.proxyLogs.createdAt, sinceDate), eq(schema.sites.status, 'active')))
      .all();

    const modelMap: Record<string, { calls: number; spend: number; tokens: number }> = {};

    for (const row of rows) {
      const log = row.proxy_logs;
      // Filter by site if siteId is specified
      if (accountIds != null && (log.accountId == null || !accountIds.has(log.accountId))) continue;

      const model = log.modelActual || log.modelRequested || 'unknown';
      const platform = row.sites?.platform || 'new-api';

      if (!modelMap[model]) modelMap[model] = { calls: 0, spend: 0, tokens: 0 };
      modelMap[model].calls++;
      modelMap[model].tokens += log.totalTokens || 0;

      const explicitCost = typeof log.estimatedCost === 'number' ? log.estimatedCost : 0;
      const cost = explicitCost > 0 ? explicitCost : fallbackTokenCost(log.totalTokens || 0, platform);
      modelMap[model].spend += cost;
    }

    const models = Object.entries(modelMap)
      .map(([model, stats]) => ({
        model,
        calls: stats.calls,
        spend: Math.round(stats.spend * 1_000_000) / 1_000_000,
        tokens: stats.tokens,
      }))
      .sort((a, b) => b.calls - a.calls);

    return { models };
  });
}
