import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isUsableAccountToken } from './accountTokenService.js';
import {
  supportsDirectAccountRoutingConnection,
} from './accountExtraConfig.js';
import { getOauthInfoFromExtraConfig } from './oauth/oauthAccount.js';
import { withSiteRecordProxyRequestInit, resolveChannelProxyUrl } from './siteProxy.js';
import { buildUpstreamEndpointRequest, type UpstreamEndpoint } from '../routes/proxy/upstreamEndpoint.js';
import { buildUpstreamUrl } from '../routes/proxy/upstreamUrl.js';
import { dispatchRuntimeRequest } from '../routes/proxy/runtimeExecutor.js';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
import { summarizeUpstreamError } from '../routes/proxy/upstreamError.js';
import { getAllowedSiteProtocolEndpoints, type SiteProtocolConfig } from './siteProtocolConfigService.js';

type ProbeClassification =
  | 'supported'
  | 'model_unavailable'
  | 'credential'
  | 'protocol_mismatch'
  | 'inconclusive';

type ProbeCredentialSource =
  | 'preferred_token'
  | 'oauth_access_token'
  | 'account_api_token'
  | 'site_api_key';

type SiteRow = typeof schema.sites.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;
type AccountTokenRow = typeof schema.accountTokens.$inferSelect;

export type SiteProtocolProbeAttempt = {
  endpoint: UpstreamEndpoint;
  checkedUrl: string;
  statusCode: number | null;
  ok: boolean;
  classification: ProbeClassification;
  reason: string;
};

export type SiteProtocolProbeResult = {
  siteId: number;
  siteName: string;
  sitePlatform: string;
  modelName: string;
  accountId: number;
  accountName: string | null;
  credentialSource: ProbeCredentialSource;
  supportedEndpoints: UpstreamEndpoint[];
  preferredEndpoint: UpstreamEndpoint;
  protocolConfig: SiteProtocolConfig;
  attempts: SiteProtocolProbeAttempt[];
  latencyMs: number;
};

type ProbeCredentialSelection = {
  tokenValue: string;
  source: ProbeCredentialSource;
  oauthProvider?: string;
  oauthProjectId?: string | null;
};

type ProbeCandidateRow = {
  modelName: string;
  account: AccountRow;
  site: SiteRow;
  token: AccountTokenRow | null;
  selection: ProbeCredentialSelection;
  credentialPriority: number;
  supportCount: number;
  isClaudeFamily: boolean;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeModelName(value: unknown): string {
  return asTrimmedString(value).toLowerCase();
}

function isClaudeFamilyModel(modelName: string): boolean {
  const normalized = normalizeModelName(modelName);
  return !!normalized && (
    normalized === 'claude'
    || normalized.startsWith('claude-')
    || normalized.includes('claude')
  );
}

function classifyProbeFailureMessage(message: string): ProbeClassification {
  const text = String(message || '').toLowerCase();
  if (!text) return 'inconclusive';

  if (
    /please use \/v1\/responses/i.test(text)
    || /please use \/v1\/messages/i.test(text)
    || /please use \/v1\/chat\/completions/i.test(text)
    || /unsupported legacy protocol/i.test(text)
    || /unsupported endpoint/i.test(text)
    || /dispatch denied/i.test(text)
    || /messages is required/i.test(text)
    || /anthropic-version/i.test(text)
    || /x-goog-api-key/i.test(text)
    || /generatecontent/i.test(text)
    || /method not allowed/i.test(text)
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
    /unauthorized|forbidden|invalid api key|authentication|token invalid|apikey invalid/i.test(text)
    || /未授权|鉴权|权限|密钥|key 无效|token 无效/i.test(text)
  ) {
    return 'credential';
  }

  return 'inconclusive';
}

function buildProbeEndpointOrder(sitePlatform: string, modelName: string): UpstreamEndpoint[] {
  const platform = asTrimmedString(sitePlatform).toLowerCase();
  const claudeFamily = isClaudeFamilyModel(modelName);

  if (platform === 'codex') return ['responses'];
  if (platform === 'claude') return ['messages'];
  if (platform === 'anyrouter') return ['messages', 'chat', 'responses'];
  if (platform === 'gemini' || platform === 'gemini-cli' || platform === 'antigravity') {
    return ['chat', 'responses'];
  }
  if (platform === 'openai') {
    return claudeFamily
      ? ['messages', 'chat', 'responses']
      : ['chat', 'responses'];
  }
  if (claudeFamily) return ['messages', 'chat', 'responses'];
  return ['chat', 'responses', 'messages'];
}

function buildPreferredEndpointPool(
  endpointOrder: UpstreamEndpoint[],
  preferredEndpoint: UpstreamEndpoint,
): UpstreamEndpoint[] {
  const uniqueOrdered = Array.from(new Set(endpointOrder));
  return [
    preferredEndpoint,
    ...uniqueOrdered.filter((endpoint) => endpoint !== preferredEndpoint),
  ];
}

function buildProtocolConfigForSuccess(
  endpointOrder: UpstreamEndpoint[],
  sitePlatform: string,
  preferredEndpoint: UpstreamEndpoint,
): SiteProtocolConfig {
  const allowedEndpoints = new Set(getAllowedSiteProtocolEndpoints(sitePlatform));
  const preferredPool = buildPreferredEndpointPool(endpointOrder, preferredEndpoint)
    .filter((endpoint): endpoint is UpstreamEndpoint => allowedEndpoints.has(endpoint));
  return {
    mode: 'manual',
    supportedEndpoints: preferredPool,
    preferredEndpoint,
    updatedAtMs: Date.now(),
  };
}

function looksLikeSuccessfulProbePayload(endpoint: UpstreamEndpoint, rawText: string): boolean {
  const text = String(rawText || '').trim();
  if (!text) return false;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return false;
    if (endpoint === 'responses') {
      return typeof parsed.id === 'string'
        || Array.isArray(parsed.output)
        || typeof parsed.output_text === 'string'
        || typeof parsed.status === 'string';
    }
    if (endpoint === 'messages') {
      return typeof parsed.id === 'string'
        || typeof parsed.type === 'string'
        || Array.isArray(parsed.content);
    }
    return typeof parsed.id === 'string'
      || Array.isArray(parsed.choices)
      || typeof parsed.object === 'string';
  } catch {
    return false;
  }
}

function credentialPriority(source: ProbeCredentialSource): number {
  switch (source) {
    case 'preferred_token':
      return 400;
    case 'oauth_access_token':
      return 300;
    case 'account_api_token':
      return 200;
    case 'site_api_key':
      return 100;
    default:
      return 0;
  }
}

function selectProbeCredential(site: SiteRow, account: AccountRow, token: AccountTokenRow | null): ProbeCredentialSelection | null {
  if (token && isUsableAccountToken(token)) {
    const tokenValue = asTrimmedString(token.token);
    if (tokenValue) {
      return {
        tokenValue,
        source: 'preferred_token',
      };
    }
  }

  const oauth = getOauthInfoFromExtraConfig(account.extraConfig);
  if (oauth?.provider) {
    const accessToken = asTrimmedString(account.accessToken);
    if (accessToken) {
      return {
        tokenValue: accessToken,
        source: 'oauth_access_token',
        oauthProvider: oauth.provider,
        oauthProjectId: oauth.projectId || null,
      };
    }
  }

  if (supportsDirectAccountRoutingConnection(account)) {
    const apiToken = asTrimmedString(account.apiToken);
    if (apiToken) {
      return {
        tokenValue: apiToken,
        source: 'account_api_token',
      };
    }
  }

  const siteApiKey = asTrimmedString(site.apiKey);
  if (siteApiKey) {
    return {
      tokenValue: siteApiKey,
      source: 'site_api_key',
    };
  }

  return null;
}

async function loadSiteForProbe(siteId: number): Promise<SiteRow | null> {
  return await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get() ?? null;
}

async function buildProbeCandidates(siteId: number): Promise<ProbeCandidateRow[]> {
  const tokenRows = await db.select()
    .from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.sites.id, siteId),
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, 'ready'),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  const accountRows = await db.select()
    .from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.sites.id, siteId),
        eq(schema.modelAvailability.available, true),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  const supportCounter = new Map<string, Set<string>>();
  const addSupport = (modelName: string, supportKey: string) => {
    const normalizedModel = normalizeModelName(modelName);
    if (!normalizedModel) return;
    if (!supportCounter.has(normalizedModel)) {
      supportCounter.set(normalizedModel, new Set());
    }
    supportCounter.get(normalizedModel)!.add(supportKey);
  };

  for (const row of tokenRows) {
    addSupport(
      row.token_model_availability.modelName,
      `token:${row.account_tokens.id}`,
    );
  }
  for (const row of accountRows) {
    addSupport(
      row.model_availability.modelName,
      `account:${row.accounts.id}`,
    );
  }

  const candidates: ProbeCandidateRow[] = [];
  for (const row of tokenRows) {
    const selection = selectProbeCredential(row.sites, row.accounts, row.account_tokens);
    if (!selection) continue;
    const modelName = asTrimmedString(row.token_model_availability.modelName);
    if (!modelName) continue;
    candidates.push({
      modelName,
      account: row.accounts,
      site: row.sites,
      token: row.account_tokens,
      selection,
      credentialPriority: credentialPriority(selection.source),
      supportCount: supportCounter.get(normalizeModelName(modelName))?.size || 1,
      isClaudeFamily: isClaudeFamilyModel(modelName),
    });
  }

  for (const row of accountRows) {
    const selection = selectProbeCredential(row.sites, row.accounts, null);
    if (!selection) continue;
    const modelName = asTrimmedString(row.model_availability.modelName);
    if (!modelName) continue;
    candidates.push({
      modelName,
      account: row.accounts,
      site: row.sites,
      token: null,
      selection,
      credentialPriority: credentialPriority(selection.source),
      supportCount: supportCounter.get(normalizeModelName(modelName))?.size || 1,
      isClaudeFamily: isClaudeFamilyModel(modelName),
    });
  }

  return candidates.sort((left, right) => (
    right.supportCount - left.supportCount
    || Number(left.isClaudeFamily) - Number(right.isClaudeFamily)
    || right.credentialPriority - left.credentialPriority
    || normalizeModelName(left.modelName).localeCompare(normalizeModelName(right.modelName))
    || left.account.id - right.account.id
  ));
}

function selectProbeCandidate(candidates: ProbeCandidateRow[], preferredModelName?: string | null): ProbeCandidateRow | null {
  const normalizedPreferred = normalizeModelName(preferredModelName);
  if (normalizedPreferred) {
    const exact = candidates.find((candidate) => normalizeModelName(candidate.modelName) === normalizedPreferred);
    if (exact) return exact;
  }
  return candidates[0] || null;
}

async function executeSingleEndpointProbe(input: {
  candidate: ProbeCandidateRow;
  endpoint: UpstreamEndpoint;
}): Promise<SiteProtocolProbeAttempt> {
  const { candidate, endpoint } = input;
  const request = buildUpstreamEndpointRequest({
    endpoint,
    modelName: candidate.modelName,
    stream: false,
    tokenValue: candidate.selection.tokenValue,
    oauthProvider: candidate.selection.oauthProvider,
    oauthProjectId: candidate.selection.oauthProjectId || undefined,
    sitePlatform: candidate.site.platform,
    siteUrl: candidate.site.url,
    openaiBody: {
      model: candidate.modelName,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      temperature: 0,
      stream: false,
    },
    downstreamFormat: endpoint === 'messages'
      ? 'claude'
      : endpoint === 'responses'
        ? 'responses'
        : 'openai',
  });

  const checkedUrl = buildUpstreamUrl(candidate.site.url, request.path);
  try {
    const response = await dispatchRuntimeRequest({
      siteUrl: candidate.site.url,
      targetUrl: checkedUrl,
      request: {
        endpoint,
        path: request.path,
        headers: request.headers,
        body: request.body,
        runtime: request.runtime,
      },
      buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(
        candidate.site,
        {
          method: 'POST',
          headers: requestForFetch.headers,
          body: JSON.stringify(requestForFetch.body),
        },
        resolveChannelProxyUrl(candidate.site, candidate.account.extraConfig),
      ),
    });

    if (response.ok) {
      const rawText = await readRuntimeResponseText(response).catch(() => '');
      if (!looksLikeSuccessfulProbePayload(endpoint, rawText)) {
        return {
          endpoint,
          checkedUrl,
          statusCode: response.status,
          ok: false,
          classification: 'inconclusive',
          reason: '探测返回了非预期成功响应，已忽略本次结果',
        };
      }
      return {
        endpoint,
        checkedUrl,
        statusCode: response.status,
        ok: true,
        classification: 'supported',
        reason: `实时探测成功（HTTP ${response.status}）`,
      };
    }

    const rawText = await readRuntimeResponseText(response).catch(() => '');
    const reason = summarizeUpstreamError(response.status, rawText);
    return {
      endpoint,
      checkedUrl,
      statusCode: response.status,
      ok: false,
      classification: classifyProbeFailureMessage(reason || rawText),
      reason,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error || 'unknown error');
    return {
      endpoint,
      checkedUrl,
      statusCode: null,
      ok: false,
      classification: classifyProbeFailureMessage(reason),
      reason,
    };
  }
}

export async function probeSiteProtocol(input: {
  siteId: number;
  modelName?: string | null;
}): Promise<SiteProtocolProbeResult> {
  const site = await loadSiteForProbe(input.siteId);
  if (!site) {
    throw new Error('Site not found');
  }
  if (site.status !== 'active') {
    throw new Error('站点已禁用，无法自动探测协议');
  }

  const candidates = await buildProbeCandidates(input.siteId);
  if (candidates.length === 0) {
    throw new Error('该站点没有可用于协议探测的可用模型或凭证');
  }

  const startedAt = Date.now();
  const orderedCandidates = (() => {
    const selected = selectProbeCandidate(candidates, input.modelName);
    if (!selected) return candidates;
    return [
      selected,
      ...candidates.filter((candidate) => candidate !== selected),
    ];
  })();
  const attempts: SiteProtocolProbeAttempt[] = [];

  for (const candidate of orderedCandidates) {
    const endpointOrder = buildProbeEndpointOrder(candidate.site.platform, candidate.modelName);
    for (const endpoint of endpointOrder) {
      const attempt = await executeSingleEndpointProbe({
        candidate,
        endpoint,
      });
      attempts.push(attempt);

      if (attempt.ok) {
        const protocolConfig = buildProtocolConfigForSuccess(
          endpointOrder,
          candidate.site.platform,
          endpoint,
        );
        return {
          siteId: candidate.site.id,
          siteName: candidate.site.name,
          sitePlatform: candidate.site.platform,
          modelName: candidate.modelName,
          accountId: candidate.account.id,
          accountName: candidate.account.username || null,
          credentialSource: candidate.selection.source,
          supportedEndpoints: protocolConfig.supportedEndpoints,
          preferredEndpoint: endpoint,
          protocolConfig,
          attempts,
          latencyMs: Date.now() - startedAt,
        };
      }

      if (attempt.classification === 'credential' || attempt.classification === 'model_unavailable') {
        break;
      }
    }
  }

  const lastAttempt = attempts[attempts.length - 1];
  throw new Error(lastAttempt?.reason || '未能探测到可用协议');
}
