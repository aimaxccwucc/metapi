import { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { getPreferredAccountToken, syncTokensFromUpstream } from '../../services/accountTokenService.js';
import { resolvePlatformUserId } from '../../services/accountExtraConfig.js';
import { fetchModelPricingCatalog } from '../../services/modelPricingService.js';
import { getAdapter } from '../../services/platforms/index.js';
import { withSiteProxyRequestInit } from '../../services/siteProxy.js';

const MARKETPLACE_MODEL_TEST_TIMEOUT_MS = 15_000;
const MARKETPLACE_AUTO_KEY_TIMEOUT_MS = 8_000;
const MARKETPLACE_MODEL_PROBE_TIMEOUT_MS = 10_000;

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
  endpoint: string | null;
  classification: 'supported' | 'model_unavailable' | 'credential' | 'protocol_mismatch' | 'inconclusive';
};

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

function classifyProbeFailureMessage(message: string): 'model_unavailable' | 'credential' | 'protocol_mismatch' | 'inconclusive' {
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

async function probeModelAvailabilityViaRealtimeCall(input: {
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
      if (classification === 'model_unavailable') {
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

export async function registerMarketplaceModelTestRoutes(app: FastifyInstance) {
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
      .filter((row: typeof modelRows[number]) => (accountId == null ? true : row.accounts.id === accountId))
      .filter((row: typeof modelRows[number]) => (siteName ? row.sites.name === siteName : true));

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

    let preferredToken = await getPreferredAccountToken(account.id);
    const fallbackSiteApiKey = (site.apiKey || '').trim();
    let modelCredential = (
      (preferredToken?.token || '').trim()
      || (account.apiToken || '').trim()
      || fallbackSiteApiKey
    );
    const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
    const accountAccessToken = (account.accessToken || '').trim();
    let autoKeyCreated = false;
    let autoKeyName: string | null = null;
    let autoKeyGroup: string | null = null;
    let autoKeyTokenId: number | null = null;

    if (!modelCredential && accountAccessToken) {
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
            (preferredToken?.token || '').trim()
            || (account.apiToken || '').trim()
            || fallbackSiteApiKey
          );
          autoKeyCreated = !!modelCredential;
          autoKeyName = generatedName;
          autoKeyGroup = targetGroup;
          autoKeyTokenId = typeof preferredToken?.id === 'number' ? preferredToken.id : null;
        }
      } catch {
        // Keep conservative behavior: fall through to explicit hint below.
      }
    }

    if (!modelCredential) {
      return reply.code(400).send({
        success: false,
        error: 'site_missing_api_key',
        message: '站点未配置可用 API Key，请先创建 Key',
        accountId: account.id,
        siteId: site.id,
        siteName: site.name,
        autoCreateAttempted: !!accountAccessToken,
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
      let reason = available ? formatProbeReason({ listHit: true, probe: null }) : formatProbeReason({ listHit: false, probe: null });
      let probeCheckedUrl: string | null = null;
      let probeStatusCode: number | null = null;
      let probeEndpoint: string | null = null;
      let probeClassification: MarketplaceProbeResult['classification'] | null = null;

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
        probeCheckedUrl,
        probeStatusCode,
        probeEndpoint,
        probeClassification,
        autoKeyCreated,
        autoKeyName,
        autoKeyGroup,
        autoKeyTokenId,
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
        autoKeyTokenId,
      });
    }
  });
}
