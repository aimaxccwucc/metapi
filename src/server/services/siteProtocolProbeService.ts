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

const MAX_PROBE_CANDIDATES = 6;
const MAX_PROBE_CANDIDATES_PER_MODEL = 3;
const PROBE_SUCCESS_CACHE_TTL_MS = 60 * 60 * 1000;
const PROBE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

type ProbeCredentialSource =
  | 'preferred_token'
  | 'oauth_access_token'
  | 'account_api_token'
  | 'site_api_key';

type SiteRow = typeof schema.sites.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;
type AccountTokenRow = typeof schema.accountTokens.$inferSelect;

export type SiteProtocolProbeSource = 'live' | 'cache' | 'cooldown_cache';

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
  attemptSummary: string[];
  latencyMs: number;
  probeSource: SiteProtocolProbeSource;
  cacheHit: boolean;
  cachedAtMs: number | null;
  cooldownUntilMs: number | null;
  cooldownRemainingMs: number;
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

type ProbeSuccessCacheEntry = {
  savedAtMs: number;
  expiresAtMs: number;
  result: SiteProtocolProbeResult;
};

type ProbeFailureCooldownEntry = {
  siteId: number;
  siteName: string;
  sitePlatform: string;
  modelName: string | null;
  attempts: SiteProtocolProbeAttempt[];
  attemptSummary: string[];
  message: string;
  cooldownUntilMs: number;
  savedAtMs: number;
};

const probeSuccessCache = new Map<string, ProbeSuccessCacheEntry>();
const probeFailureCooldowns = new Map<string, ProbeFailureCooldownEntry>();
let probeRuntimeContextTag: string | null = null;

export class SiteProtocolProbeError extends Error {
  siteId: number;
  siteName: string;
  sitePlatform: string;
  modelName: string | null;
  attempts: SiteProtocolProbeAttempt[];
  attemptSummary: string[];
  probeSource: SiteProtocolProbeSource;
  cooldownUntilMs: number | null;
  cooldownRemainingMs: number;

  constructor(input: {
    message: string;
    siteId: number;
    siteName: string;
    sitePlatform: string;
    modelName: string | null;
    attempts: SiteProtocolProbeAttempt[];
    attemptSummary: string[];
    probeSource: SiteProtocolProbeSource;
    cooldownUntilMs?: number | null;
    cooldownRemainingMs?: number;
  }) {
    super(input.message);
    this.name = 'SiteProtocolProbeError';
    this.siteId = input.siteId;
    this.siteName = input.siteName;
    this.sitePlatform = input.sitePlatform;
    this.modelName = input.modelName;
    this.attempts = input.attempts;
    this.attemptSummary = input.attemptSummary;
    this.probeSource = input.probeSource;
    this.cooldownUntilMs = input.cooldownUntilMs ?? null;
    this.cooldownRemainingMs = input.cooldownRemainingMs ?? 0;
  }
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeModelName(value: unknown): string {
  return asTrimmedString(value).toLowerCase();
}

function getProbeRuntimeContextTag(): string | null {
  const dataDir = (process.env.DATA_DIR || '').trim();
  return dataDir || null;
}

function refreshProbeRuntimeContext(): void {
  const nextTag = getProbeRuntimeContextTag();
  if (nextTag === probeRuntimeContextTag) return;
  probeSuccessCache.clear();
  probeFailureCooldowns.clear();
  probeRuntimeContextTag = nextTag;
}

function buildProbeCacheKey(siteId: number, modelName?: string | null): string {
  const normalizedModel = normalizeModelName(modelName);
  return `${siteId}:${normalizedModel || '*'}`;
}

function cloneProbeAttempt(attempt: SiteProtocolProbeAttempt): SiteProtocolProbeAttempt {
  return {
    endpoint: attempt.endpoint,
    checkedUrl: attempt.checkedUrl,
    statusCode: attempt.statusCode,
    ok: attempt.ok,
    classification: attempt.classification,
    reason: attempt.reason,
  };
}

function cloneProbeResult(result: SiteProtocolProbeResult): SiteProtocolProbeResult {
  return {
    ...result,
    supportedEndpoints: [...result.supportedEndpoints],
    protocolConfig: {
      ...result.protocolConfig,
      supportedEndpoints: [...result.protocolConfig.supportedEndpoints],
    },
    attempts: result.attempts.map(cloneProbeAttempt),
    attemptSummary: [...result.attemptSummary],
  };
}

function buildAttemptSummary(attempts: SiteProtocolProbeAttempt[]): string[] {
  return attempts.map((attempt, index) => (
    `${index + 1}. ${attempt.endpoint} ${attempt.ok ? 'success' : attempt.classification}: ${attempt.reason}`
  ));
}

function buildProbeFailureMessage(attempts: SiteProtocolProbeAttempt[]): string {
  if (attempts.length === 0) return '未能探测到可用协议';
  const lastAttempt = attempts[attempts.length - 1];
  const headline = lastAttempt?.reason || '未能探测到可用协议';
  return `协议探测失败，已尝试 ${attempts.length} 次：${headline}`;
}

function getCachedSuccessResult(
  siteId: number,
  modelName: string | null | undefined,
  nowMs: number,
): SiteProtocolProbeResult | null {
  const entry = probeSuccessCache.get(buildProbeCacheKey(siteId, modelName));
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs) {
    probeSuccessCache.delete(buildProbeCacheKey(siteId, modelName));
    return null;
  }
  const cloned = cloneProbeResult(entry.result);
  cloned.probeSource = 'cache';
  cloned.cacheHit = true;
  cloned.cachedAtMs = entry.savedAtMs;
  cloned.cooldownUntilMs = null;
  cloned.cooldownRemainingMs = 0;
  cloned.latencyMs = 0;
  return cloned;
}

function getActiveFailureCooldown(
  siteId: number,
  modelName: string | null | undefined,
  nowMs: number,
): ProbeFailureCooldownEntry | null {
  const key = buildProbeCacheKey(siteId, modelName);
  const entry = probeFailureCooldowns.get(key);
  if (!entry) return null;
  if (entry.cooldownUntilMs <= nowMs) {
    probeFailureCooldowns.delete(key);
    return null;
  }
  return entry;
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

function buildProtocolConfigForSuccess(
  sitePlatform: string,
  modelName: string,
  preferredEndpoint: UpstreamEndpoint,
  attempts: SiteProtocolProbeAttempt[],
): SiteProtocolConfig {
  const allowedEndpoints = new Set(getAllowedSiteProtocolEndpoints(sitePlatform));
  const protocolMismatchEndpoints = new Set(
    attempts
      .filter((attempt) => !attempt.ok && attempt.classification === 'protocol_mismatch')
      .map((attempt) => attempt.endpoint),
  );
  const preferredPool = buildProbeEndpointOrder(sitePlatform, modelName)
    .filter((endpoint) => allowedEndpoints.has(endpoint) && !protocolMismatchEndpoints.has(endpoint));
  const supportedEndpoints = preferredPool.includes(preferredEndpoint)
    ? preferredPool
    : [preferredEndpoint, ...preferredPool];
  return {
    mode: 'manual',
    supportedEndpoints,
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

function buildOrderedProbeCandidates(
  candidates: ProbeCandidateRow[],
  preferredModelName?: string | null,
): ProbeCandidateRow[] {
  if (candidates.length <= 1) return candidates;
  const selected = selectProbeCandidate(candidates, preferredModelName);
  if (!selected) return candidates.slice(0, MAX_PROBE_CANDIDATES);

  const selectedModel = normalizeModelName(selected.modelName);
  const sameModelCandidates = candidates
    .filter((candidate) => normalizeModelName(candidate.modelName) === selectedModel)
    .slice(0, MAX_PROBE_CANDIDATES_PER_MODEL);
  const sameModelSet = new Set(sameModelCandidates);
  const fallbackCandidates = candidates
    .filter((candidate) => !sameModelSet.has(candidate))
    .slice(0, Math.max(0, MAX_PROBE_CANDIDATES - sameModelCandidates.length));

  const ordered = [
    selected,
    ...sameModelCandidates.filter((candidate) => candidate !== selected),
    ...fallbackCandidates.filter((candidate) => candidate !== selected),
  ];

  return ordered.slice(0, MAX_PROBE_CANDIDATES);
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
      messages: [{ role: 'user', content: 'Respond with exactly one sentence describing the weather today.' }],
      max_tokens: 8,
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
  refreshProbeRuntimeContext();

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
  const cachedSuccess = getCachedSuccessResult(input.siteId, input.modelName, startedAt);
  if (cachedSuccess) {
    return cachedSuccess;
  }
  const activeCooldown = getActiveFailureCooldown(input.siteId, input.modelName, startedAt);
  if (activeCooldown) {
    throw new SiteProtocolProbeError({
      message: `站点协议探测冷却中，请 ${Math.max(1, Math.ceil((activeCooldown.cooldownUntilMs - startedAt) / 1000))} 秒后重试`,
      siteId: activeCooldown.siteId,
      siteName: activeCooldown.siteName,
      sitePlatform: activeCooldown.sitePlatform,
      modelName: activeCooldown.modelName,
      attempts: activeCooldown.attempts.map(cloneProbeAttempt),
      attemptSummary: [...activeCooldown.attemptSummary],
      probeSource: 'cooldown_cache',
      cooldownUntilMs: activeCooldown.cooldownUntilMs,
      cooldownRemainingMs: Math.max(0, activeCooldown.cooldownUntilMs - startedAt),
    });
  }

  const orderedCandidates = buildOrderedProbeCandidates(candidates, input.modelName);
  const attempts: SiteProtocolProbeAttempt[] = [];

  for (const candidate of orderedCandidates) {
    const endpointOrder = buildProbeEndpointOrder(candidate.site.platform, candidate.modelName);
    const probePromises = endpointOrder.map((endpoint) => executeSingleEndpointProbe({ candidate, endpoint }));
    const probeResults = await Promise.allSettled(probePromises);
    const candidateAttempts: SiteProtocolProbeAttempt[] = probeResults
      .map((result) => result.status === 'fulfilled' ? result.value : null)
      .filter((attempt): attempt is SiteProtocolProbeAttempt => attempt !== null);
    attempts.push(...candidateAttempts);

    const successAttempt = candidateAttempts.find((attempt) => attempt.ok);
    if (successAttempt) {
      const protocolConfig = buildProtocolConfigForSuccess(
        candidate.site.platform,
        candidate.modelName,
        successAttempt.endpoint,
        attempts,
      );
      const result: SiteProtocolProbeResult = {
        siteId: candidate.site.id,
        siteName: candidate.site.name,
        sitePlatform: candidate.site.platform,
        modelName: candidate.modelName,
        accountId: candidate.account.id,
        accountName: candidate.account.username || null,
        credentialSource: candidate.selection.source,
        supportedEndpoints: protocolConfig.supportedEndpoints,
        preferredEndpoint: successAttempt.endpoint,
        protocolConfig,
        attempts,
        attemptSummary: buildAttemptSummary(attempts),
        latencyMs: Date.now() - startedAt,
        probeSource: 'live',
        cacheHit: false,
        cachedAtMs: null,
        cooldownUntilMs: null,
        cooldownRemainingMs: 0,
      };
      probeSuccessCache.set(buildProbeCacheKey(input.siteId, input.modelName), {
        savedAtMs: Date.now(),
        expiresAtMs: Date.now() + PROBE_SUCCESS_CACHE_TTL_MS,
        result: cloneProbeResult(result),
      });
      probeFailureCooldowns.delete(buildProbeCacheKey(input.siteId, input.modelName));
      return result;
    }

    if (candidateAttempts.some((attempt) => attempt.classification === 'credential')) {
      continue;
    }
  }

  const cooldownUntilMs = Date.now() + PROBE_FAILURE_COOLDOWN_MS;
  const attemptSummary = buildAttemptSummary(attempts);
  const message = buildProbeFailureMessage(attempts);
  probeFailureCooldowns.set(buildProbeCacheKey(input.siteId, input.modelName), {
    siteId: site.id,
    siteName: site.name,
    sitePlatform: site.platform,
    modelName: selectProbeCandidate(orderedCandidates, input.modelName)?.modelName || null,
    attempts: attempts.map(cloneProbeAttempt),
    attemptSummary: [...attemptSummary],
    message,
    cooldownUntilMs,
    savedAtMs: Date.now(),
  });
  throw new SiteProtocolProbeError({
    message,
    siteId: site.id,
    siteName: site.name,
    sitePlatform: site.platform,
    modelName: selectProbeCandidate(orderedCandidates, input.modelName)?.modelName || null,
    attempts,
    attemptSummary,
    probeSource: 'live',
    cooldownUntilMs,
    cooldownRemainingMs: PROBE_FAILURE_COOLDOWN_MS,
  });
}

export function resetSiteProtocolProbeRuntimeState(): void {
  probeSuccessCache.clear();
  probeFailureCooldowns.clear();
  probeRuntimeContextTag = getProbeRuntimeContextTag();
}
