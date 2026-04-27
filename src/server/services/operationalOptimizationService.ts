import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { extractCheckinSnapshot, getProxyUrlFromExtraConfig, requiresManagedAccountTokens } from './accountExtraConfig.js';
import { extractRuntimeHealth } from './accountHealthService.js';
import { listCheckinSiteRuntimeSnapshots } from './checkinSiteRuntime.js';
import { isSchedulableCheckinAccountStatus } from './checkinService.js';
import { getResponseCacheRuntimeStatus } from './responseCacheService.js';
import { getRetryBackoffMetrics } from '../routes/proxy/requestBudget.js';
import { getModelCircuitSnapshots } from './modelCircuitBreaker.js';
import { listActiveRoutingGovernanceStates } from './routingGovernanceService.js';
import { listSiteProtocolConfigs } from './siteProtocolConfigService.js';
import { listSiteRuntimeHealthSnapshots, listAccountRoutingRuntimeSnapshots, listPersistedUnavailableModelEntries } from './tokenRouter.js';

type SiteProtocolConfigRecord = Awaited<ReturnType<typeof listSiteProtocolConfigs>>;

const RESPONSE_CACHE_POLICY_SETTING_KEY = 'response_cache_policy_v1';
const RETRY_BUDGET_POLICY_SETTING_KEY = 'retry_budget_policy_v1';

type SiteRow = typeof schema.sites.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;
type CheckinStateRow = typeof schema.checkinStates.$inferSelect;

export type OptimizationItemStatus = 'ready' | 'attention' | 'missing';

export type OptimizationItem = {
  id: string;
  title: string;
  area: '站点' | '签到' | '账号' | '模型广场' | '路由' | '网关' | '运维';
  status: OptimizationItemStatus;
  evidence: string;
  action: string;
};

export type OperationalOptimizationOverview = {
  success: true;
  generatedAt: string;
  scores: {
    usability: number;
    stability: number;
    speed: number;
    tokenSavings: number;
    overall: number;
  };
  counts: {
    sites: number;
    activeSites: number;
    siteProfiles: number;
    protocolProfiles: number;
    accounts: number;
    activeAccounts: number;
    checkinStates: number;
    checkinAttention: number;
    modelCapabilities: number;
    governanceSuppressed: number;
    governanceProbing: number;
    responseCacheHits: number;
    responseCacheMisses: number;
  };
  policies: {
    responseCache: ResponseCachePolicy;
    retryBudget: RetryBudgetPolicy;
  };
  topSites: Array<{
    siteId: number;
    name: string;
    platform: string;
    operationalScore: number;
    onboardingScore: number;
    accountCount: number;
    activeAccountCount: number;
    checkinAttention: number;
    routeGovernanceCount: number;
    protocolPreferredEndpoint: string | null;
  }>;
  attention: Array<{
    type: 'site' | 'account' | 'route' | 'gateway';
    severity: 'info' | 'warning' | 'error';
    title: string;
    detail: string;
    action: string;
    targetId?: number;
  }>;
  optimizationItems: OptimizationItem[];
  metrics: {
    responseCache: ReturnType<typeof getResponseCacheRuntimeStatus>;
    retryBackoff: ReturnType<typeof getRetryBackoffMetrics>;
  };
};

export type ResponseCachePolicy = {
  enabled: boolean;
  ttlMs: number;
  maxRows: number;
  staleIfErrorMs: number;
  deterministicOnly: boolean;
};

export type RetryBudgetPolicy = {
  requestBudgetMs: number;
  maxRetries: number;
  maxChannelAttempts: number;
  honorRetryAfter: boolean;
  failFastOnKnownBadEndpoint: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function asPlainObject<T extends Record<string, unknown>>(value: unknown): Partial<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Partial<T>;
}

function boundedInteger(value: unknown, fallback: number, min: number, max?: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const bounded = Math.max(min, Math.trunc(numeric));
  return typeof max === 'number' ? Math.min(max, bounded) : bounded;
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function normalizeModelName(modelName: string): string {
  const normalized = modelName.trim().toLowerCase();
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function inferModelCapability(modelName: string) {
  const model = normalizeModelName(modelName);
  const isClaude = model.includes('claude');
  const isGemini = model.includes('gemini');
  const isEmbedding = model.includes('embedding') || model.includes('embed');
  const isImage = model.includes('image') || model.includes('dall-e') || model.includes('gpt-image');
  const isReasoning = /(^|[-_.])(o\d|gpt-5|reason|thinking|r1|opus|sonnet)/i.test(model);
  const supportsVision = !isEmbedding && (isClaude || isGemini || model.includes('gpt-4') || model.includes('gpt-5') || model.includes('vision') || isImage);
  const endpointTypes = isClaude
    ? ['messages', 'chat', 'responses']
    : (isGemini ? ['responses', 'chat'] : ['chat', 'responses']);
  return {
    endpointTypes,
    supportsTools: !isEmbedding && !isImage,
    supportsVision,
    supportsFiles: !isEmbedding && (isClaude || isGemini || model.includes('gpt-4') || model.includes('gpt-5')),
    supportsReasoning: isReasoning,
    supportsStreaming: !isEmbedding,
    confidence: 'medium',
  };
}

function resolveCredentialMode(site: SiteRow, accounts: AccountRow[]): string {
  if (site.apiKey && site.apiKey.trim()) return 'site_key';
  const hasSession = accounts.some((account) => !!account.accessToken?.trim());
  const hasApiToken = accounts.some((account) => !!account.apiToken?.trim());
  if (hasSession && hasApiToken) return 'mixed';
  if (hasSession) return 'session';
  if (hasApiToken) return 'apikey';
  return 'unknown';
}

function platformSupportsAdminApi(platform: string): boolean {
  const normalized = platform.trim().toLowerCase();
  return ['new-api', 'one-api', 'one-hub', 'done-hub', 'veloera', 'sub2api', 'anyrouter'].includes(normalized);
}

function resolveWafProfile(site: SiteRow): string {
  if (site.flaresolverrUrl && site.flaresolverrUrl.trim()) return 'cloudflare_bypass_configured';
  if (site.proxyUrl && site.proxyUrl.trim()) return 'proxy_configured';
  return 'unknown';
}

function computeSiteScores(input: {
  site: SiteRow;
  accounts: AccountRow[];
  checkinAttention: number;
  governanceCount: number;
  protocolPreferredEndpoint: string | null;
}): { onboardingScore: number; operationalScore: number } {
  const activeAccounts = input.accounts.filter((account) => account.status === 'active').length;
  let onboardingScore = 20;
  if (input.site.status === 'active') onboardingScore += 15;
  if (input.accounts.length > 0) onboardingScore += 20;
  if (activeAccounts > 0) onboardingScore += 15;
  if (input.protocolPreferredEndpoint) onboardingScore += 15;
  if (platformSupportsAdminApi(input.site.platform || '')) onboardingScore += 10;
  if (input.site.healthStatus === 'alive') onboardingScore += 5;

  let operationalScore = onboardingScore;
  operationalScore -= input.checkinAttention * 8;
  operationalScore -= input.governanceCount * 10;
  if (input.site.status === 'disabled') operationalScore -= 35;
  if (input.site.healthStatus === 'unreachable') operationalScore -= 25;
  if (activeAccounts === 0) operationalScore -= 20;

  return {
    onboardingScore: clampScore(onboardingScore),
    operationalScore: clampScore(operationalScore),
  };
}

async function portableUpsertByAccountId(
  table: typeof schema.checkinStates,
  accountId: number,
  values: typeof schema.checkinStates.$inferInsert,
): Promise<void> {
  const existing = await db.select({ id: table.id }).from(table).where(eq(table.accountId, accountId)).get();
  if (existing?.id) {
    await db.update(table).set(values).where(eq(table.id, existing.id)).run();
    return;
  }
  await db.insert(table).values(values).run();
}

async function portableUpsertBySiteId<TTable extends typeof schema.siteProfiles | typeof schema.siteProtocolProfiles>(
  table: TTable,
  siteId: number,
  values: TTable['$inferInsert'],
): Promise<void> {
  const existing = await db.select({ id: table.id }).from(table as any).where(eq((table as any).siteId, siteId)).get();
  if (existing?.id) {
    await db.update(table as any).set(values).where(eq((table as any).id, existing.id)).run();
    return;
  }
  await db.insert(table as any).values(values).run();
}

async function portableUpsertModelCapability(modelName: string, values: typeof schema.modelCapabilityProfiles.$inferInsert): Promise<void> {
  const existing = await db.select({ id: schema.modelCapabilityProfiles.id })
    .from(schema.modelCapabilityProfiles)
    .where(eq(schema.modelCapabilityProfiles.modelName, modelName))
    .get();
  if (existing?.id) {
    await db.update(schema.modelCapabilityProfiles).set(values).where(eq(schema.modelCapabilityProfiles.id, existing.id)).run();
    return;
  }
  await db.insert(schema.modelCapabilityProfiles).values(values).run();
}

export async function syncCheckinStateForAccount(input: {
  account: AccountRow;
  site: SiteRow;
  status: string;
  reasonCode?: string | null;
  message?: string | null;
  retryable?: boolean;
  requiresManual?: boolean;
  unsupported?: boolean;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  nextRetryAt?: string | null;
  lastReloginStatus?: string | null;
  scheduleMode?: string | null;
}): Promise<void> {
  if (!schema.checkinStates?.accountId || !schema.checkinStates?.siteId) {
    return;
  }
  const existing = await db.select().from(schema.checkinStates)
    .where(eq(schema.checkinStates.accountId, input.account.id))
    .get() as CheckinStateRow | undefined;
  const failed = input.status === 'retryable_failed' || input.status === 'terminal_failed' || input.status === 'site_unreachable';
  const consecutiveFailures = failed ? Math.max(0, (existing?.consecutiveFailures ?? 0) + 1) : 0;
  const updatedAt = nowIso();
  await portableUpsertByAccountId(schema.checkinStates, input.account.id, {
    accountId: input.account.id,
    siteId: input.site.id,
    status: input.status || 'unknown',
    reasonCode: input.reasonCode ?? null,
    message: input.message ?? null,
    retryable: input.retryable === true,
    requiresManual: input.requiresManual === true,
    unsupported: input.unsupported === true,
    consecutiveFailures,
    lastAttemptAt: input.lastAttemptAt ?? updatedAt,
    lastSuccessAt: input.lastSuccessAt ?? existing?.lastSuccessAt ?? null,
    nextRetryAt: input.nextRetryAt ?? null,
    lastReloginStatus: input.lastReloginStatus ?? existing?.lastReloginStatus ?? null,
    scheduleMode: input.scheduleMode ?? null,
    updatedAt,
    createdAt: existing?.createdAt ?? updatedAt,
  });
}

export async function backfillCheckinStatesFromAccounts(): Promise<number> {
  const rows = await db.select({ account: schema.accounts, site: schema.sites })
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();
  let changed = 0;
  for (const row of rows) {
    const snapshot = extractCheckinSnapshot(row.account.extraConfig);
    if (!snapshot) continue;
    await syncCheckinStateForAccount({
      account: row.account,
      site: row.site,
      status: snapshot.status || 'unknown',
      reasonCode: snapshot.reasonCode ?? null,
      message: snapshot.message ?? null,
      retryable: snapshot.retryable === true,
      requiresManual: snapshot.requiresManual === true,
      unsupported: snapshot.unsupported === true,
      lastAttemptAt: snapshot.lastAttemptAt ?? null,
      lastSuccessAt: snapshot.lastSuccessAt ?? null,
      nextRetryAt: snapshot.nextRetryAt ?? null,
      scheduleMode: snapshot.scheduleMode ?? null,
    });
    changed += 1;
  }
  return changed;
}

export function getDefaultResponseCachePolicy(): ResponseCachePolicy {
  return {
    enabled: config.responseCacheEnabled === true,
    ttlMs: config.responseCacheTtlMs,
    maxRows: config.responseCacheMaxRows,
    staleIfErrorMs: config.responseCacheStaleIfErrorMs,
    deterministicOnly: true,
  };
}

export function getDefaultRetryBudgetPolicy(): RetryBudgetPolicy {
  return {
    requestBudgetMs: config.upstreamRequestBudgetMs,
    maxRetries: config.proxyMaxRetries,
    maxChannelAttempts: config.proxyMaxChannelAttempts,
    honorRetryAfter: true,
    failFastOnKnownBadEndpoint: true,
  };
}

export async function readOperationalPolicies(): Promise<{ responseCache: ResponseCachePolicy; retryBudget: RetryBudgetPolicy }> {
  const rows = await db.select().from(schema.settings)
    .where(inArray(schema.settings.key, [RESPONSE_CACHE_POLICY_SETTING_KEY, RETRY_BUDGET_POLICY_SETTING_KEY]))
    .all();
  const map = new Map(rows.map((row: { key: string; value: string | null }) => [row.key, row.value]));
  return {
    responseCache: {
      ...getDefaultResponseCachePolicy(),
      ...safeJsonParse<Partial<ResponseCachePolicy>>(map.get(RESPONSE_CACHE_POLICY_SETTING_KEY), {}),
    },
    retryBudget: {
      ...getDefaultRetryBudgetPolicy(),
      ...safeJsonParse<Partial<RetryBudgetPolicy>>(map.get(RETRY_BUDGET_POLICY_SETTING_KEY), {}),
    },
  };
}

export async function updateOperationalPolicies(input: {
  responseCache?: Partial<ResponseCachePolicy>;
  retryBudget?: Partial<RetryBudgetPolicy>;
}) {
  const current = await readOperationalPolicies();
  const responseCachePatch = asPlainObject<ResponseCachePolicy>(input.responseCache);
  const retryBudgetPatch = asPlainObject<RetryBudgetPolicy>(input.retryBudget);
  const responseCache: ResponseCachePolicy = {
    ...current.responseCache,
    ...responseCachePatch,
    ttlMs: boundedInteger(responseCachePatch.ttlMs, current.responseCache.ttlMs, 1_000),
    maxRows: boundedInteger(responseCachePatch.maxRows, current.responseCache.maxRows, 100),
    staleIfErrorMs: boundedInteger(responseCachePatch.staleIfErrorMs, current.responseCache.staleIfErrorMs, 1_000),
    enabled: responseCachePatch.enabled === undefined ? current.responseCache.enabled : responseCachePatch.enabled === true,
    deterministicOnly: responseCachePatch.deterministicOnly === undefined ? current.responseCache.deterministicOnly : responseCachePatch.deterministicOnly !== false,
  };
  const retryBudget: RetryBudgetPolicy = {
    ...current.retryBudget,
    ...retryBudgetPatch,
    requestBudgetMs: boundedInteger(retryBudgetPatch.requestBudgetMs, current.retryBudget.requestBudgetMs, 1_000),
    maxRetries: boundedInteger(retryBudgetPatch.maxRetries, current.retryBudget.maxRetries, 0, 8),
    maxChannelAttempts: boundedInteger(retryBudgetPatch.maxChannelAttempts, current.retryBudget.maxChannelAttempts, 1),
    honorRetryAfter: retryBudgetPatch.honorRetryAfter === undefined ? current.retryBudget.honorRetryAfter : retryBudgetPatch.honorRetryAfter !== false,
    failFastOnKnownBadEndpoint: retryBudgetPatch.failFastOnKnownBadEndpoint === undefined ? current.retryBudget.failFastOnKnownBadEndpoint : retryBudgetPatch.failFastOnKnownBadEndpoint !== false,
  };
  await upsertSetting(RESPONSE_CACHE_POLICY_SETTING_KEY, responseCache);
  await upsertSetting(RETRY_BUDGET_POLICY_SETTING_KEY, retryBudget);
  return { responseCache, retryBudget };
}

export async function syncOperationalProfiles(): Promise<{ checkinStates: number; siteProfiles: number; protocolProfiles: number; modelCapabilities: number }> {
  const [sites, accounts, checkinStates, governanceStates, protocolConfigs, modelRows, tokenModelRows] = await Promise.all([
    db.select().from(schema.sites).all() as Promise<SiteRow[]>,
    db.select().from(schema.accounts).all() as Promise<AccountRow[]>,
    db.select().from(schema.checkinStates).all() as Promise<CheckinStateRow[]>,
    listActiveRoutingGovernanceStates({ states: ['suppressed', 'probing'], limit: 500 }),
    listSiteProtocolConfigs(),
    db.select({ modelName: schema.modelAvailability.modelName }).from(schema.modelAvailability).all() as Promise<Array<{ modelName: string }>>,
    db.select({ modelName: schema.tokenModelAvailability.modelName }).from(schema.tokenModelAvailability).all() as Promise<Array<{ modelName: string }>>,
  ]);

  const accountsBySiteId = new Map<number, AccountRow[]>();
  for (const account of accounts) {
    if (!accountsBySiteId.has(account.siteId)) accountsBySiteId.set(account.siteId, []);
    accountsBySiteId.get(account.siteId)!.push(account);
  }
  const checkinAttentionBySiteId = new Map<number, number>();
  for (const state of checkinStates) {
    if (state.requiresManual || state.status === 'retryable_failed' || state.status === 'terminal_failed' || state.status === 'site_unreachable') {
      checkinAttentionBySiteId.set(state.siteId, (checkinAttentionBySiteId.get(state.siteId) || 0) + 1);
    }
  }
  const governanceBySiteId = new Map<number, number>();
  for (const item of governanceStates) {
    if (item.subjectType === 'site') {
      governanceBySiteId.set(item.subjectId, (governanceBySiteId.get(item.subjectId) || 0) + 1);
    }
  }
  const protocolConfigBySiteId = new Map<number, SiteProtocolConfigRecord[number]>(
    Object.entries(protocolConfigs).map(([siteId, siteProtocolConfig]) => [Number(siteId), siteProtocolConfig]),
  );

  const timestamp = nowIso();
  let siteProfiles = 0;
  let protocolProfiles = 0;
  for (const site of sites) {
    const siteAccounts = accountsBySiteId.get(site.id) ?? [];
    const protocolConfig = protocolConfigBySiteId.get(site.id);
    const scores = computeSiteScores({
      site,
      accounts: siteAccounts,
      checkinAttention: checkinAttentionBySiteId.get(site.id) || 0,
      governanceCount: governanceBySiteId.get(site.id) || 0,
      protocolPreferredEndpoint: protocolConfig?.preferredEndpoint ?? null,
    });
    await portableUpsertBySiteId(schema.siteProfiles, site.id, {
      siteId: site.id,
      platform: site.platform || 'unknown',
      credentialMode: resolveCredentialMode(site, siteAccounts),
      supportsAdminApi: platformSupportsAdminApi(site.platform || ''),
      supportsCheckin: site.autoCheckinPolicy !== 'unsupported',
      wafProfile: resolveWafProfile(site),
      modelDiscoverySource: siteAccounts.some((account) => requiresManagedAccountTokens(account)) ? 'managed_tokens' : 'account_models',
      onboardingScore: scores.onboardingScore,
      operationalScore: scores.operationalScore,
      lastDetectedAt: timestamp,
      profileJson: JSON.stringify({
        accountCount: siteAccounts.length,
        activeAccountCount: siteAccounts.filter((account) => account.status === 'active').length,
        checkinAttention: checkinAttentionBySiteId.get(site.id) || 0,
        governanceCount: governanceBySiteId.get(site.id) || 0,
        proxyConfigured: !!getProxyUrlFromExtraConfig(siteAccounts[0]?.extraConfig) || !!site.proxyUrl,
      }),
      updatedAt: timestamp,
    });
    siteProfiles += 1;

    if (protocolConfig) {
      const supportedEndpoints = protocolConfig.supportedEndpoints || [];
      await portableUpsertBySiteId(schema.siteProtocolProfiles, site.id, {
        siteId: site.id,
        preferredEndpoint: protocolConfig.preferredEndpoint ?? null,
        verifiedEndpoints: JSON.stringify(supportedEndpoints),
        fallbackEndpoints: JSON.stringify(supportedEndpoints.filter((endpoint) => endpoint !== protocolConfig.preferredEndpoint)),
        probeModelName: null,
        lastSuccessAt: protocolConfig.updatedAtMs ? new Date(protocolConfig.updatedAtMs).toISOString() : null,
        lastFailureCode: null,
        cooldownUntil: null,
        source: protocolConfig.mode || 'derived',
        profileVersion: 1,
        updatedAt: timestamp,
      });
      protocolProfiles += 1;
    }
  }

  const modelNames = uniq([...modelRows, ...tokenModelRows].map((row) => String(row.modelName || '').trim()).filter(Boolean));
  let modelCapabilities = 0;
  for (const modelName of modelNames) {
    const cap = inferModelCapability(modelName);
    await portableUpsertModelCapability(modelName, {
      modelName,
      endpointTypes: JSON.stringify(cap.endpointTypes),
      supportsTools: cap.supportsTools,
      supportsVision: cap.supportsVision,
      supportsFiles: cap.supportsFiles,
      supportsReasoning: cap.supportsReasoning,
      supportsStreaming: cap.supportsStreaming,
      source: 'heuristic',
      confidence: cap.confidence,
      updatedAt: timestamp,
    });
    modelCapabilities += 1;
  }

  const backfilled = await backfillCheckinStatesFromAccounts();
  return { checkinStates: backfilled, siteProfiles, protocolProfiles, modelCapabilities };
}

function buildOptimizationItems(input: {
  siteProfileCount: number;
  protocolProfileCount: number;
  checkinStateCount: number;
  checkinAttention: number;
  accountRuntimeCount: number;
  modelCapabilityCount: number;
  governanceTotal: number;
  responseCachePolicy: ResponseCachePolicy;
  responseCacheHits: number;
  retryBudgetPolicy: RetryBudgetPolicy;
  taskCenterReady: boolean;
}): OptimizationItem[] {
  return [
    { id: 'site-score', title: '站点接入评分', area: '站点', status: input.siteProfileCount > 0 ? 'ready' : 'missing', evidence: `站点画像 ${input.siteProfileCount} 条`, action: '进入优化工作台或站点页查看评分。' },
    { id: 'site-profile', title: '站点类型画像', area: '站点', status: input.siteProfileCount > 0 ? 'ready' : 'missing', evidence: '记录平台、凭证模式、WAF、模型来源。', action: '点击同步画像刷新派生信息。' },
    { id: 'protocol-profile', title: '协议能力画像', area: '网关', status: input.protocolProfileCount > 0 ? 'ready' : 'attention', evidence: `协议画像 ${input.protocolProfileCount} 条`, action: '对未探测站点执行有限协议探测。' },
    { id: 'checkin-state', title: '签到状态独立快照', area: '签到', status: input.checkinStateCount > 0 ? 'ready' : 'attention', evidence: `签到状态 ${input.checkinStateCount} 条`, action: '运行一次签到或同步画像回填历史快照。' },
    { id: 'checkin-attention', title: '签到人工待办', area: '签到', status: input.checkinAttention > 0 ? 'attention' : 'ready', evidence: `需处理 ${input.checkinAttention} 个账号`, action: '处理 manual_required / retryable_failed 账号。' },
    { id: 'account-capacity', title: '账号承载能力视图', area: '账号', status: input.accountRuntimeCount > 0 ? 'ready' : 'attention', evidence: `账号运行时快照 ${input.accountRuntimeCount} 条`, action: '产生真实流量后可查看 EMA、并发和速率预算。' },
    { id: 'marketplace-copy', title: '模型广场测完即用', area: '模型广场', status: 'ready', evidence: '已支持模型可用性测试与自动补 Key 结果。', action: '在模型广场测试后复制成功 Key 或诊断摘要。' },
    { id: 'model-capability', title: '模型能力矩阵', area: '模型广场', status: input.modelCapabilityCount > 0 ? 'ready' : 'attention', evidence: `模型能力 ${input.modelCapabilityCount} 条`, action: '同步画像后按模型名称生成能力记忆。' },
    { id: 'route-governance', title: '路由治理操作', area: '路由', status: 'ready', evidence: `治理状态 ${input.governanceTotal} 条`, action: '可执行恢复轮转或查看系统隔离列表。' },
    { id: 'diagnostic-summary', title: '标准化诊断摘要', area: '运维', status: 'ready', evidence: '优化工作台聚合站点、账号、路由、缓存、重试指标。', action: '复制工作台摘要用于排障。' },
    { id: 'response-cache-policy', title: '响应缓存策略', area: '网关', status: input.responseCachePolicy.enabled ? 'ready' : 'attention', evidence: `命中 ${input.responseCacheHits} 次，当前${input.responseCachePolicy.enabled ? '启用' : '未启用'}`, action: '只对确定性请求启用缓存以省 token。' },
    { id: 'preflight-budget', title: '请求前预算判断', area: '网关', status: 'ready', evidence: '下游 Key 和请求预算已有前置校验入口。', action: '为下游 Key 设置模型、路线、成本和次数限制。' },
    { id: 'retry-budget', title: '重试预算统一', area: '网关', status: input.retryBudgetPolicy.failFastOnKnownBadEndpoint ? 'ready' : 'attention', evidence: `预算 ${input.retryBudgetPolicy.requestBudgetMs}ms，最大重试 ${input.retryBudgetPolicy.maxRetries}`, action: '保持 fail-fast，避免重复撞坏 endpoint。' },
    { id: 'onboarding-workbench', title: '接入向导工作台', area: '站点', status: 'ready', evidence: '优化工作台聚合站点画像和下一步动作。', action: '新增站点后先同步画像并执行有限探测。' },
    { id: 'event-timeline', title: '治理事件时间线', area: '运维', status: 'ready', evidence: '后台任务、签到、治理恢复已进入 events/tasks。', action: '在任务中心和程序日志查看状态。' },
    { id: 'task-center', title: '统一任务中心', area: '运维', status: input.taskCenterReady ? 'ready' : 'missing', evidence: input.taskCenterReady ? '后台任务 API 已可用' : '后台任务 API 未就绪', action: '使用任务页跟踪批量签到、探测、同步。' },
  ];
}

async function hasAnyOperationalProfileRows(): Promise<boolean> {
  const [checkinState, siteProfile, protocolProfile, modelCapability] = await Promise.all([
    db.select({ id: schema.checkinStates.id }).from(schema.checkinStates).limit(1).get(),
    db.select({ id: schema.siteProfiles.id }).from(schema.siteProfiles).limit(1).get(),
    db.select({ id: schema.siteProtocolProfiles.id }).from(schema.siteProtocolProfiles).limit(1).get(),
    db.select({ id: schema.modelCapabilityProfiles.id }).from(schema.modelCapabilityProfiles).limit(1).get(),
  ]);
  return !!(checkinState || siteProfile || protocolProfile || modelCapability);
}

export async function buildOperationalOptimizationOverview(): Promise<OperationalOptimizationOverview> {
  if (!await hasAnyOperationalProfileRows()) {
    await syncOperationalProfiles();
  }
  const nowMs = Date.now();
  const [
    sites,
    accounts,
    checkinStates,
    siteProfiles,
    protocolProfiles,
    modelCapabilityProfiles,
    governanceStates,
    siteRuntimeRows,
    accountRuntimeRows,
    modelCircuitRows,
    unavailableModelRows,
    checkinSiteRuntimeRows,
    policies,
  ] = await Promise.all([
    db.select().from(schema.sites).all() as Promise<SiteRow[]>,
    db.select().from(schema.accounts).all() as Promise<AccountRow[]>,
    db.select().from(schema.checkinStates).all() as Promise<CheckinStateRow[]>,
    db.select().from(schema.siteProfiles).all(),
    db.select().from(schema.siteProtocolProfiles).all(),
    db.select().from(schema.modelCapabilityProfiles).all(),
    listActiveRoutingGovernanceStates({ states: ['suppressed', 'probing'], limit: 500 }),
    listSiteRuntimeHealthSnapshots(nowMs),
    listAccountRoutingRuntimeSnapshots(nowMs),
    getModelCircuitSnapshots(nowMs),
    listPersistedUnavailableModelEntries(),
    listCheckinSiteRuntimeSnapshots(nowMs),
    readOperationalPolicies(),
  ]);

  const accountsBySiteId = new Map<number, AccountRow[]>();
  for (const account of accounts) {
    if (!accountsBySiteId.has(account.siteId)) accountsBySiteId.set(account.siteId, []);
    accountsBySiteId.get(account.siteId)!.push(account);
  }
  const profileBySiteId = new Map(siteProfiles.map((profile: any) => [profile.siteId, profile]));
  const protocolBySiteId = new Map(protocolProfiles.map((profile: any) => [profile.siteId, profile]));
  const checkinAttentionBySiteId = new Map<number, number>();
  for (const state of checkinStates) {
    if (state.requiresManual || state.status === 'retryable_failed' || state.status === 'terminal_failed' || state.status === 'site_unreachable') {
      checkinAttentionBySiteId.set(state.siteId, (checkinAttentionBySiteId.get(state.siteId) || 0) + 1);
    }
  }
  const governanceBySiteId = new Map<number, number>();
  for (const item of governanceStates) {
    if (item.subjectType === 'site') governanceBySiteId.set(item.subjectId, (governanceBySiteId.get(item.subjectId) || 0) + 1);
  }

  const checkinAttention = checkinStates.filter((state) => (
    state.requiresManual || state.status === 'retryable_failed' || state.status === 'terminal_failed' || state.status === 'site_unreachable'
  )).length;
  const governanceSuppressed = governanceStates.filter((item) => item.state === 'suppressed').length;
  const governanceProbing = governanceStates.filter((item) => item.state === 'probing').length;
  const responseCache = getResponseCacheRuntimeStatus();
  const retryBackoff = getRetryBackoffMetrics();

  const topSites = sites.map((site) => {
    const siteAccounts = accountsBySiteId.get(site.id) ?? [];
    const profile = profileBySiteId.get(site.id) as typeof schema.siteProfiles.$inferSelect | undefined;
    const protocol = protocolBySiteId.get(site.id) as typeof schema.siteProtocolProfiles.$inferSelect | undefined;
    return {
      siteId: site.id,
      name: site.name,
      platform: site.platform,
      operationalScore: profile?.operationalScore ?? 0,
      onboardingScore: profile?.onboardingScore ?? 0,
      accountCount: siteAccounts.length,
      activeAccountCount: siteAccounts.filter((account) => account.status === 'active').length,
      checkinAttention: checkinAttentionBySiteId.get(site.id) || 0,
      routeGovernanceCount: governanceBySiteId.get(site.id) || 0,
      protocolPreferredEndpoint: protocol?.preferredEndpoint ?? null,
    };
  }).sort((left, right) => left.operationalScore - right.operationalScore).slice(0, 8);

  const activeAccounts = accounts.filter((account) => account.status === 'active').length;
  const activeSites = sites.filter((site) => site.status === 'active').length;
  const stabilityPenalty = checkinAttention * 4 + governanceSuppressed * 5 + modelCircuitRows.filter((item) => item.status.isOpen).length * 4;
  const speedPenalty = siteRuntimeRows.filter((item) => item.multiplier < 0.999).length * 4 + retryBackoff.budgetExhaustedCount * 3;
  const cacheTotal = responseCache.hits + responseCache.misses;
  const cacheRate = cacheTotal > 0 ? responseCache.hits / cacheTotal : 0;
  const usability = clampScore(50 + (siteProfiles.length > 0 ? 20 : 0) + (protocolProfiles.length > 0 ? 10 : 0) + (modelCapabilityProfiles.length > 0 ? 10 : 0) + (activeSites > 0 ? 10 : 0));
  const stability = clampScore(100 - stabilityPenalty);
  const speed = clampScore(80 - speedPenalty + Math.min(20, Math.round(cacheRate * 20)));
  const tokenSavings = clampScore((policies.responseCache.enabled ? 40 : 10) + Math.min(30, responseCache.hits * 3) + Math.min(30, Math.round(responseCache.savedTokens / 1_000)));
  const overall = clampScore((usability + stability + speed + tokenSavings) / 4);

  const optimizationItems = buildOptimizationItems({
    siteProfileCount: siteProfiles.length,
    protocolProfileCount: protocolProfiles.length,
    checkinStateCount: checkinStates.length,
    checkinAttention,
    accountRuntimeCount: accountRuntimeRows.length,
    modelCapabilityCount: modelCapabilityProfiles.length,
    governanceTotal: governanceStates.length,
    responseCachePolicy: policies.responseCache,
    responseCacheHits: responseCache.hits,
    retryBudgetPolicy: policies.retryBudget,
    taskCenterReady: true,
  });

  const attention: OperationalOptimizationOverview['attention'] = [];
  for (const state of checkinStates.slice(0, 8)) {
    if (!(state.requiresManual || state.status === 'retryable_failed' || state.status === 'terminal_failed' || state.status === 'site_unreachable')) continue;
    attention.push({
      type: 'account',
      severity: state.requiresManual ? 'warning' : 'error',
      title: `签到状态：${state.status}`,
      detail: state.message || state.reasonCode || '无详细原因',
      action: state.requiresManual ? '人工完成验证后重新签到' : '等待退避结束或手动重试',
      targetId: state.accountId,
    });
  }
  if (governanceSuppressed > 0) {
    attention.push({
      type: 'route',
      severity: 'warning',
      title: '存在系统隔离通道',
      detail: `${governanceSuppressed} 条路由治理状态仍处于 suppressed`,
      action: '查看路由治理列表或执行恢复轮转',
    });
  }
  if (unavailableModelRows.some((item) => item.stillBlocking)) {
    attention.push({
      type: 'route',
      severity: 'info',
      title: '存在模型不可用记忆',
      detail: `${unavailableModelRows.filter((item) => item.stillBlocking).length} 条模型记忆仍在阻断`,
      action: '对相关模型执行定向复验',
    });
  }
  if (checkinSiteRuntimeRows.some((item) => item.blocked)) {
    attention.push({
      type: 'site',
      severity: 'warning',
      title: '站点签到退避生效',
      detail: `${checkinSiteRuntimeRows.filter((item) => item.blocked).length} 个站点处于签到退避`,
      action: '等待站点恢复或降低签到频率',
    });
  }

  return {
    success: true,
    generatedAt: nowIso(),
    scores: { usability, stability, speed, tokenSavings, overall },
    counts: {
      sites: sites.length,
      activeSites,
      siteProfiles: siteProfiles.length,
      protocolProfiles: protocolProfiles.length,
      accounts: accounts.length,
      activeAccounts,
      checkinStates: checkinStates.length,
      checkinAttention,
      modelCapabilities: modelCapabilityProfiles.length,
      governanceSuppressed,
      governanceProbing,
      responseCacheHits: responseCache.hits,
      responseCacheMisses: responseCache.misses,
    },
    policies,
    topSites,
    attention,
    optimizationItems,
    metrics: {
      responseCache,
      retryBackoff,
    },
  };
}

export async function buildOperationalDiagnosticsText(): Promise<string> {
  const overview = await buildOperationalOptimizationOverview();
  const ready = overview.optimizationItems.filter((item) => item.status === 'ready').length;
  const attention = overview.optimizationItems.filter((item) => item.status === 'attention').length;
  const missing = overview.optimizationItems.filter((item) => item.status === 'missing').length;
  return [
    `Metapi 优化诊断 ${overview.generatedAt}`,
    `总分: ${overview.scores.overall} / 好用 ${overview.scores.usability} / 稳定 ${overview.scores.stability} / 快 ${overview.scores.speed} / 省 token ${overview.scores.tokenSavings}`,
    `16项状态: ready=${ready}, attention=${attention}, missing=${missing}`,
    `站点: ${overview.counts.activeSites}/${overview.counts.sites} active, 账号: ${overview.counts.activeAccounts}/${overview.counts.accounts} active`,
    `签到待处理: ${overview.counts.checkinAttention}, 路由隔离: ${overview.counts.governanceSuppressed}, 复测中: ${overview.counts.governanceProbing}`,
    `缓存: hit=${overview.counts.responseCacheHits}, miss=${overview.counts.responseCacheMisses}, savedTokens=${overview.metrics.responseCache.savedTokens}`,
    ...overview.attention.slice(0, 8).map((item) => `[${item.severity}] ${item.title}: ${item.detail} -> ${item.action}`),
  ].join('\n');
}
