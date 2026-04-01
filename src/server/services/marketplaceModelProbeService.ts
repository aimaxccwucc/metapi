import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getPreferredAccountToken, syncTokensFromUpstream } from './accountTokenService.js';
import { resolvePlatformUserId } from './accountExtraConfig.js';
import { fetchModelPricingCatalog } from './modelPricingService.js';
import { getAdapter } from './platforms/index.js';
import { withSiteProxyRequestInit } from './siteProxy.js';

const MARKETPLACE_MODEL_TEST_TIMEOUT_MS = 15_000;
const MARKETPLACE_AUTO_KEY_TIMEOUT_MS = 8_000;
const MARKETPLACE_MODEL_PROBE_TIMEOUT_MS = 10_000;

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
    /unauthorized|forbidden|invalid api key|authentication|auth|token|apikey/i.test(text)
    || /未授权|鉴权|权限|密钥|key 无效|token 无效/i.test(text)
  ) {
    return 'credential';
  }
  return 'inconclusive';
}

function formatProbeReason(input: { listHit: boolean; probe: MarketplaceProbeResult | null }): string {
  if (input.listHit) return '模型已出现在上游列表中';
  if (!input.probe) return '上游模型列表未包含该模型，且未完成实时探测';

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
  return `上游列表未命中，实时探测未得出确定结论：${input.probe.reason}`;
}

function buildProbeEndpoints(platform: string): Array<'chat' | 'responses' | 'messages'> {
  const normalized = String(platform || '').trim().toLowerCase();
  if (normalized === 'claude') return ['messages', 'chat', 'responses'];
  return ['chat', 'responses', 'messages'];
}

function buildProbeRequest(baseUrl: string, modelName: string, endpoint: 'chat' | 'responses' | 'messages') {
  const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (endpoint === 'responses') {
    return {
      url: `${normalizedBase}/v1/responses`,
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
      url: `${normalizedBase}/v1/messages`,
      body: {
        model: modelName,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      },
    };
  }
  return {
    url: `${normalizedBase}/v1/chat/completions`,
    body: {
      model: modelName,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
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
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 1, temperature: 0 },
    },
  };
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
      const response = await withTimeout(
        async () => {
          return await fetch(
            probe.url,
            await withSiteProxyRequestInit(probe.url, {
              method: 'POST',
              headers,
              body: JSON.stringify(probe.body),
              signal: AbortSignal.timeout(MARKETPLACE_MODEL_PROBE_TIMEOUT_MS),
            }),
          );
        },
        MARKETPLACE_MODEL_PROBE_TIMEOUT_MS + 500,
        `model probe timeout (${Math.round(MARKETPLACE_MODEL_PROBE_TIMEOUT_MS / 1000)}s)`,
      );

      if (response.ok) {
        return {
          available: true,
          reason: `probe succeeded via ${endpoint} (HTTP ${response.status})`,
          checkedUrl: probe.url,
          statusCode: response.status,
          endpoint,
          classification: 'supported',
        };
      }

      const responseText = await response.text();
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
    const geminiResponse = await withTimeout(
      async () => {
        return await fetch(
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
      },
      MARKETPLACE_MODEL_PROBE_TIMEOUT_MS + 500,
      `model probe timeout (${Math.round(MARKETPLACE_MODEL_PROBE_TIMEOUT_MS / 1000)}s)`,
    );

    if (geminiResponse.ok) {
      return {
        available: true,
        reason: `probe succeeded via gemini-native (HTTP ${geminiResponse.status})`,
        checkedUrl: geminiProbe.url,
        statusCode: geminiResponse.status,
        endpoint: 'gemini-native',
        classification: 'supported',
      };
    }

    const geminiText = await geminiResponse.text();
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

function buildAutoTokenName(modelName: string, preferredGroup: string): string {
  const normalizedGroup = preferredGroup.trim() || 'default';
  const normalizedModel = modelName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'model';
  return `metapi-${normalizedGroup}-${normalizedModel}`.slice(0, 64);
}

function selectPreferredTokenGroupForModel(
  modelName: string,
  availableGroups: string[],
  catalog: Awaited<ReturnType<typeof fetchModelPricingCatalog>>,
): string {
  const normalizedGroups = Array.from(new Set(
    availableGroups.map((group) => String(group || '').trim()).filter(Boolean),
  ));
  if (normalizedGroups.length === 0) return 'default';
  if (normalizedGroups.length === 1) return normalizedGroups[0] || 'default';

  const groupRatio = catalog?.groupRatio || {};
  const modelEntry = catalog?.models.find((item) => item.modelName === modelName)
    || catalog?.models.find((item) => isModelAliasEquivalent(item.modelName, modelName))
    || catalog?.models.find((item) => normalizedGroups.some((group) => item.enableGroups.includes(group)));
  const allowedGroups = new Set(modelEntry?.enableGroups || normalizedGroups);

  const rankedGroups = normalizedGroups
    .filter((group) => allowedGroups.has(group))
    .map((group) => ({
      group,
      ratio: typeof groupRatio[group] === 'number' && Number.isFinite(groupRatio[group])
        ? groupRatio[group]
        : Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.ratio - right.ratio || left.group.localeCompare(right.group));

  const preferred = rankedGroups.find((item) => Number.isFinite(item.ratio));
  return preferred?.group || normalizedGroups[0] || 'default';
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
    if (!token) {
      throw new MarketplaceModelProbeError(400, {
        success: false,
        error: 'token_not_found',
        message: `账号 ${candidate.account.id} 下不存在令牌 ${preferredTokenId}`,
        accountId: candidate.account.id,
        tokenId: preferredTokenId,
      });
    }
    return token;
  }

  if (candidate.token) return candidate.token;
  return await getPreferredAccountToken(candidate.account.id);
}

export async function resolveMarketplaceProbeCandidate(input: {
  modelName: string;
  accountId?: number | null;
  siteName?: string | null;
}): Promise<MarketplaceProbeCandidate> {
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
    .filter((row: typeof modelRows[number]) => (input.accountId == null ? true : row.accounts.id === input.accountId))
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
  preferredCredential?: string | null;
  allowAutoCreateKey?: boolean;
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
  let modelCredential = (
    (input.preferredCredential || '').trim()
    || (preferredToken?.token || '').trim()
    || (account.apiToken || '').trim()
    || fallbackSiteApiKey
  );
  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  const accountAccessToken = (account.accessToken || '').trim();
  const allowAutoCreateKey = input.allowAutoCreateKey !== false;
  let autoKeyCreated = false;
  let autoKeyName: string | null = null;
  let autoKeyGroup: string | null = null;
  let autoKeyTokenId: number | null = null;

  if (!modelCredential && allowAutoCreateKey && accountAccessToken) {
    try {
      const availableGroups = await withTimeout(
        () => adapter.getUserGroups(site.url, accountAccessToken, platformUserId),
        MARKETPLACE_AUTO_KEY_TIMEOUT_MS,
        `list groups timeout (${Math.round(MARKETPLACE_AUTO_KEY_TIMEOUT_MS / 1000)}s)`,
      );
      const pricingCatalog = await fetchModelPricingCatalog({
        site: {
          id: site.id,
          url: site.url,
          platform: site.platform,
        },
        account: {
          id: account.id,
          accessToken: accountAccessToken,
          apiToken: account.apiToken,
        },
        modelName: '__metadata__',
        totalTokens: 0,
      }).catch(() => null);
      const targetGroup = selectPreferredTokenGroupForModel(modelName, availableGroups, pricingCatalog);
      const generatedName = buildAutoTokenName(modelName, targetGroup);
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
        modelCredential = (
          (input.preferredCredential || '').trim()
          || (preferredToken?.token || '').trim()
          || (account.apiToken || '').trim()
          || fallbackSiteApiKey
        );
        autoKeyCreated = !!modelCredential;
        autoKeyName = generatedName;
        autoKeyGroup = targetGroup;
        autoKeyTokenId = typeof preferredToken?.id === 'number' ? preferredToken.id : null;
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
    const discoveredModels = await withTimeout(
      () => adapter.getModels(site.url, modelCredential, platformUserId),
      MARKETPLACE_MODEL_TEST_TIMEOUT_MS,
      `model test timeout (${Math.round(MARKETPLACE_MODEL_TEST_TIMEOUT_MS / 1000)}s)`,
    );
    const normalizedSet = new Set(
      (Array.isArray(discoveredModels) ? discoveredModels : [])
        .map((item) => String(item || '').trim())
        .filter((item) => item.length > 0),
    );
    let available = normalizedSet.has(modelName)
      || Array.from(normalizedSet).some((item) => isModelAliasEquivalent(item, modelName));
    const listHit = available;
    let reason = available ? formatProbeReason({ listHit: true, probe: null }) : formatProbeReason({ listHit: false, probe: null });
    let probeCheckedUrl: string | null = null;
    let probeStatusCode: number | null = null;
    let probeEndpoint: string | null = null;
    let probeClassification: MarketplaceProbeClassification | null = null;

    if (!available) {
      const probe = await probeModelAvailabilityViaRealtimeCall({
        baseUrl: site.url,
        platform: site.platform,
        credential: modelCredential,
        modelName,
      });
      probeCheckedUrl = probe.checkedUrl;
      probeStatusCode = probe.statusCode;
      probeEndpoint = probe.endpoint;
      probeClassification = probe.classification;
      if (probe.available === true) {
        available = true;
      }
      reason = formatProbeReason({ listHit: false, probe });
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
      detectionMethod: listHit ? 'model_list' : (probeEndpoint ? 'realtime_probe' : 'unknown'),
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
  preferredCredential?: string | null;
  allowAutoCreateKey?: boolean;
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
    preferredCredential: input.preferredCredential,
    allowAutoCreateKey: input.allowAutoCreateKey,
  });
}

export async function probeMarketplaceModelAvailability(input: {
  modelName: string;
  accountId?: number | null;
  siteName?: string | null;
  preferredTokenId?: number | null;
  preferredCredential?: string | null;
  skipAutoCreate?: boolean;
}): Promise<MarketplaceModelAvailabilitySuccess | MarketplaceModelAvailabilityFailure> {
  try {
    return await testMarketplaceModelAvailability({
      modelName: input.modelName,
      accountId: input.accountId,
      siteName: input.siteName,
      preferredTokenId: input.preferredTokenId,
      preferredCredential: input.preferredCredential,
      allowAutoCreateKey: input.skipAutoCreate !== true,
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
