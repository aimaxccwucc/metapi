import { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { getAdapter } from '../../services/platforms/index.js';
import { getCredentialModeFromExtraConfig, resolvePlatformUserId } from '../../services/accountExtraConfig.js';
import { withAccountProxyOverride, withSiteProxyRequestInit } from '../../services/siteProxy.js';
import { probeSiteProtocol, SiteProtocolProbeError } from '../../services/siteProtocolProbeService.js';
import { parseRouteDecisionSnapshot } from '../../services/routeDecisionSnapshotStore.js';
import { listActiveRoutingGovernanceStates } from '../../services/routingGovernanceService.js';
import { getDownstreamApiKeyById } from '../../services/downstreamApiKeyService.js';
import { probeModelAvailabilityViaRealtimeCall } from '../../services/marketplaceModelProbeService.js';

type DiagnosticTargetType = 'site' | 'account' | 'token';
type BenchmarkRoundCount = 1 | 3;

type DiagnosticSiteRow = typeof schema.sites.$inferSelect;
type DiagnosticAccountRow = typeof schema.accounts.$inferSelect;
type DiagnosticTokenRow = typeof schema.accountTokens.$inferSelect;

type DiagnosticResolvedTarget =
  | {
    type: 'site';
    site: DiagnosticSiteRow;
    account: null;
    token: null;
    credential: string | null;
    credentialSource: 'site_api_key' | 'none';
    platformUserId: undefined;
  }
  | {
    type: 'account';
    site: DiagnosticSiteRow;
    account: DiagnosticAccountRow;
    token: null;
    credential: string | null;
    credentialSource: 'account_api_token' | 'account_access_token' | 'site_api_key' | 'none';
    platformUserId: number | undefined;
  }
  | {
    type: 'token';
    site: DiagnosticSiteRow;
    account: DiagnosticAccountRow;
    token: DiagnosticTokenRow;
    credential: string | null;
    credentialSource: 'managed_token' | 'account_api_token' | 'account_access_token' | 'site_api_key' | 'none';
    platformUserId: number | undefined;
  };

type BenchmarkSample = {
  ok: boolean;
  elapsedMs: number | null;
  firstTokenMs: number | null;
  error: string | null;
};

type BenchmarkItem = {
  modelName: string;
  rounds: BenchmarkRoundCount;
  samples: BenchmarkSample[];
  successRate: number;
  avgLatencyMs: number | null;
  medianLatencyMs: number | null;
  medianFirstTokenMs: number | null;
};

function normalizeTargetType(value: unknown): DiagnosticTargetType | null {
  if (value === 'site' || value === 'account' || value === 'token') return value;
  return null;
}

function normalizePositiveId(value: unknown): number | null {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeBenchmarkRounds(value: unknown): BenchmarkRoundCount {
  const parsed = Number.parseInt(String(value || ''), 10);
  return parsed === 3 ? 3 : 1;
}

function normalizeSiteUrl(input: string): string {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function isApiKeyCredentialAccount(account: DiagnosticAccountRow): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit === 'apikey') return true;
  if (explicit === 'session') return false;
  return !(account.accessToken || '').trim() && !!(account.apiToken || '').trim();
}

function selectAccountCredential(account: DiagnosticAccountRow, site: DiagnosticSiteRow): {
  credential: string | null;
  source: 'account_api_token' | 'account_access_token' | 'site_api_key' | 'none';
} {
  const apiToken = (account.apiToken || '').trim();
  const accessToken = (account.accessToken || '').trim();
  const siteApiKey = (site.apiKey || '').trim();

  if (isApiKeyCredentialAccount(account) && apiToken) {
    return { credential: apiToken, source: 'account_api_token' };
  }
  if (apiToken) {
    return { credential: apiToken, source: 'account_api_token' };
  }
  if (accessToken) {
    return { credential: accessToken, source: 'account_access_token' };
  }
  if (siteApiKey) {
    return { credential: siteApiKey, source: 'site_api_key' };
  }
  return { credential: null, source: 'none' };
}

async function resolveDiagnosticTarget(type: DiagnosticTargetType, id: number): Promise<DiagnosticResolvedTarget | null> {
  if (type === 'site') {
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!site) return null;
    return {
      type,
      site,
      account: null,
      token: null,
      credential: (site.apiKey || '').trim() || null,
      credentialSource: (site.apiKey || '').trim() ? 'site_api_key' : 'none',
      platformUserId: undefined,
    };
  }

  if (type === 'account') {
    const row = await db.select()
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accounts.id, id))
      .get();
    if (!row) return null;
    const selected = selectAccountCredential(row.accounts, row.sites);
    return {
      type,
      site: row.sites,
      account: row.accounts,
      token: null,
      credential: selected.credential,
      credentialSource: selected.source,
      platformUserId: resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username),
    };
  }

  const row = await db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accountTokens.id, id))
    .get();
  if (!row) return null;
  const fallback = selectAccountCredential(row.accounts, row.sites);
  const tokenValue = (row.account_tokens.token || '').trim();
  return {
    type,
    site: row.sites,
    account: row.accounts,
    token: row.account_tokens,
    credential: tokenValue || fallback.credential,
    credentialSource: tokenValue ? 'managed_token' : fallback.source,
    platformUserId: resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username),
  };
}

function buildConnectivityPayload(target: DiagnosticResolvedTarget) {
  const normalizedUrl = normalizeSiteUrl(target.site.url);
  return {
    normalizedUrl,
    reachable: target.site.healthStatus === 'alive' ? true : (target.site.healthStatus === 'unreachable' ? false : null),
    status: target.site.healthStatus || 'unknown',
    message: target.site.healthReason || null,
    checkedAt: target.site.healthCheckedAt || null,
    credentialPresent: !!target.credential,
    credentialSource: target.credentialSource,
  };
}

async function loadVisibleModels(target: DiagnosticResolvedTarget): Promise<Array<{ name: string; latencyMs: number | null; disabled: boolean; isManual: boolean }>> {
  if (!target.account) return [];
  const disabledRows = await db.select({ modelName: schema.siteDisabledModels.modelName })
    .from(schema.siteDisabledModels)
    .where(eq(schema.siteDisabledModels.siteId, target.site.id))
    .all();
  const disabledSet = new Set(disabledRows.map((row) => row.modelName));

  if (target.token) {
    const rows = await db.select({
      modelName: schema.tokenModelAvailability.modelName,
      available: schema.tokenModelAvailability.available,
      latencyMs: schema.tokenModelAvailability.latencyMs,
    }).from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, target.token.id))
      .all();
    return rows
      .filter((row) => row.available)
      .map((row) => ({
        name: row.modelName,
        latencyMs: row.latencyMs ?? null,
        disabled: disabledSet.has(row.modelName),
        isManual: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const rows = await db.select({
    modelName: schema.modelAvailability.modelName,
    available: schema.modelAvailability.available,
    latencyMs: schema.modelAvailability.latencyMs,
    isManual: schema.modelAvailability.isManual,
  }).from(schema.modelAvailability)
    .where(eq(schema.modelAvailability.accountId, target.account.id))
    .all();

  return rows
    .filter((row) => row.available)
    .map((row) => ({
      name: row.modelName,
      latencyMs: row.latencyMs ?? null,
      disabled: disabledSet.has(row.modelName),
      isManual: !!row.isManual,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function runConnectivityProbe(target: DiagnosticResolvedTarget): Promise<{ reachable: boolean | null; statusCode: number | null; latencyMs: number | null; detail: string | null }> {
  const normalizedUrl = normalizeSiteUrl(target.site.url);
  if (!normalizedUrl) {
    return { reachable: false, statusCode: null, latencyMs: null, detail: '站点 URL 无效' };
  }
  const { fetch } = await import('undici');
  const startedAt = Date.now();
  try {
    const response = await fetch(
      normalizedUrl,
      await withSiteProxyRequestInit(normalizedUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(8_000),
      }),
    );
    return {
      reachable: response.ok,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
      detail: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      reachable: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error || '请求失败'),
    };
  }
}

async function runProtocolProbe(target: DiagnosticResolvedTarget, suggestedModel: string | null) {
  try {
    const result = await probeSiteProtocol({
      siteId: target.site.id,
      modelName: suggestedModel || undefined,
    });
    const protocolLabel = result.preferredEndpoint === 'messages'
      ? 'claude-messages'
      : result.preferredEndpoint === 'responses'
        ? 'responses'
        : 'chat-completions';
    return {
      ok: true,
      protocol: protocolLabel,
      preferredEndpoint: result.preferredEndpoint,
      supportedEndpoints: result.supportedEndpoints,
      probeSource: result.probeSource,
      latencyMs: result.latencyMs,
      attemptSummary: result.attemptSummary,
      accountId: result.accountId,
      accountName: result.accountName,
    };
  } catch (error) {
    if (error instanceof SiteProtocolProbeError) {
      return {
        ok: false,
        protocol: null,
        preferredEndpoint: null,
        supportedEndpoints: [],
        probeSource: error.probeSource,
        latencyMs: null,
        attemptSummary: error.attemptSummary,
        accountId: null,
        accountName: null,
        error: error.message,
      };
    }
    return {
      ok: false,
      protocol: null,
      preferredEndpoint: null,
      supportedEndpoints: [],
      probeSource: 'live',
      latencyMs: null,
      attemptSummary: [],
      accountId: null,
      accountName: null,
      error: error instanceof Error ? error.message : String(error || '协议探测失败'),
    };
  }
}

async function runMinimalModelProbe(target: DiagnosticResolvedTarget, modelName: string | null) {
  if (!modelName || !target.credential) {
    return {
      ok: false,
      modelName,
      requestPath: null,
      requestFormat: null,
      errorSummary: modelName ? '缺少可用凭证' : '缺少可用模型',
      rawPreview: null,
    };
  }

  const probe = await withAccountProxyOverride(
    target.account ? null : null,
    () => probeModelAvailabilityViaRealtimeCall({
      baseUrl: target.site.url,
      platform: target.site.platform,
      credential: target.credential!,
      modelName,
    }),
  );

  const requestPath = probe.checkedUrl
    ? (() => {
      try {
        const url = new URL(probe.checkedUrl);
        return `${url.pathname}${url.search}`;
      } catch {
        return probe.checkedUrl;
      }
    })()
    : null;

  return {
    ok: probe.available === true,
    modelName,
    requestPath,
    requestFormat: probe.endpoint,
    errorSummary: probe.available === true ? null : probe.reason,
    rawPreview: probe.reason,
    classification: probe.classification,
    statusCode: probe.statusCode,
  };
}

function extractDecisionModelName(snapshot: any): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (typeof snapshot.model === 'string' && snapshot.model.trim()) return snapshot.model.trim();
  if (typeof snapshot.modelName === 'string' && snapshot.modelName.trim()) return snapshot.modelName.trim();
  if (typeof snapshot.requestedModel === 'string' && snapshot.requestedModel.trim()) return snapshot.requestedModel.trim();
  return null;
}

async function loadRoutingImpact(target: DiagnosticResolvedTarget) {
  if (!target.account) {
    return {
      referencedRoutes: [] as Array<{ id: number; modelPattern: string; displayName: string | null; decisionSnapshot: unknown | null; decisionRefreshedAt: string | null }>,
      governance: [] as Array<{ id: number; subjectType: string; subjectId: number; state: string; reasonCode: string; modelName: string; updatedAt: string | null }>,
      downstreamKeys: [] as Array<{ id: number; name: string; groupName: string | null }>,
    };
  }

  const routeChannels = await db.select({
    routeId: schema.routeChannels.routeId,
  }).from(schema.routeChannels)
    .where(target.token
      ? and(
        eq(schema.routeChannels.accountId, target.account.id),
        eq(schema.routeChannels.tokenId, target.token.id),
      )
      : eq(schema.routeChannels.accountId, target.account.id))
    .all();

  const routeIds: number[] = [];
  for (const row of routeChannels) {
    const routeId = Number(row.routeId);
    if (!Number.isFinite(routeId) || routeId <= 0 || routeIds.includes(routeId)) continue;
    routeIds.push(routeId);
  }
  const referencedRoutes = routeIds.length > 0
    ? await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      displayName: schema.tokenRoutes.displayName,
      decisionSnapshot: schema.tokenRoutes.decisionSnapshot,
      decisionRefreshedAt: schema.tokenRoutes.decisionRefreshedAt,
    }).from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, routeIds))
      .all()
    : [];

  const governanceStates = await listActiveRoutingGovernanceStates({
    limit: 100,
    states: ['suppressed', 'probing'],
    subjectTypes: target.token ? ['token', 'account', 'site', 'channel'] : ['account', 'site', 'channel'],
  });

  const governance = governanceStates.filter((entry) => {
    if (entry.subjectType === 'site') return entry.subjectId === target.site.id;
    if (entry.subjectType === 'account') return entry.subjectId === target.account!.id;
    if (entry.subjectType === 'token') return target.token ? entry.subjectId === target.token.id : false;
    return false;
  }).map((entry) => ({
    id: entry.id,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    state: entry.state,
    reasonCode: entry.reasonCode,
    modelName: entry.modelName || '',
    updatedAt: entry.updatedAt ?? null,
  }));

  const downstreamRows = await db.select({
    id: schema.downstreamApiKeys.id,
  }).from(schema.downstreamApiKeys).all();

  const downstreamKeys: Array<{ id: number; name: string; groupName: string | null }> = [];
  for (const row of downstreamRows) {
    const view = await getDownstreamApiKeyById(row.id);
    if (!view) continue;
    if (routeIds.some((routeId) => view.allowedRouteIds.includes(routeId))) {
      downstreamKeys.push({
        id: view.id,
        name: view.name,
        groupName: view.groupName,
      });
    }
  }

  return {
    referencedRoutes: referencedRoutes.map((route) => ({
      id: route.id,
      modelPattern: route.modelPattern,
      displayName: route.displayName ?? null,
      decisionSnapshot: parseRouteDecisionSnapshot(route.decisionSnapshot),
      decisionRefreshedAt: route.decisionRefreshedAt ?? null,
    })),
    governance,
    downstreamKeys,
  };
}

function isBenchmarkCandidate(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  if (!normalized) return false;
  const blockedKeywords = ['embedding', 'rerank', 'moderation', 'tts', 'speech', 'image', 'video', 'vision-preview'];
  return !blockedKeywords.some((keyword) => normalized.includes(keyword));
}

async function runBenchmarkRequest(target: DiagnosticResolvedTarget, modelName: string) {
  if (!target.credential) {
    return { ok: false, elapsedMs: null, firstTokenMs: null, error: '缺少可用凭证' };
  }

  const { fetch } = await import('undici');
  const protocol = String(target.site.platform || '').trim().toLowerCase() === 'claude' ? 'messages' : 'chat';
  const normalizedBase = target.site.url.trim().replace(/\/+$/, '');
  const startedAt = Date.now();
  try {
    if (protocol === 'messages') {
      const response = await fetch(
        `${normalizedBase}/v1/messages`,
        await withSiteProxyRequestInit(normalizedBase, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': target.credential,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: modelName,
            max_tokens: 8,
            messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
          }),
          signal: AbortSignal.timeout(12_000),
        }),
      );
      const elapsedMs = Date.now() - startedAt;
      if (!response.ok) {
        return { ok: false, elapsedMs, firstTokenMs: null, error: await response.text() };
      }
      return { ok: true, elapsedMs, firstTokenMs: null, error: null };
    }

    const response = await fetch(
      `${normalizedBase}/v1/chat/completions`,
      await withSiteProxyRequestInit(normalizedBase, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.credential}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
          max_tokens: 8,
          temperature: 0,
          stream: true,
        }),
        signal: AbortSignal.timeout(18_000),
      }),
    );

    if (!response.ok || !response.body) {
      const elapsedMs = Date.now() - startedAt;
      const text = await response.text().catch(() => `HTTP ${response.status}`);
      return { ok: false, elapsedMs, firstTokenMs: null, error: text };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstTokenMs: number | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const lines = chunk.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('data:'));
        for (const line of lines) {
          const data = line.replace(/^data:\s*/, '');
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as any;
            const delta = parsed?.choices?.[0]?.delta?.content;
            const text = typeof delta === 'string'
              ? delta
              : (Array.isArray(delta) ? delta.map((item) => item?.text || '').join('') : '');
            if (text && firstTokenMs == null) {
              firstTokenMs = Date.now() - startedAt;
            }
          } catch {
            // ignore malformed sse events
          }
        }
      }
    }
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      firstTokenMs,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      firstTokenMs: null,
      error: error instanceof Error ? error.message : String(error || '测速失败'),
    };
  }
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 100) / 100;
  }
  return sorted[middle] ?? null;
}

function pickRecommendedBenchmark(results: Array<{
  modelName: string;
  successRate: number;
  medianLatencyMs: number | null;
  avgLatencyMs: number | null;
  medianFirstTokenMs: number | null;
}>): { modelName: string; reason: string } | null {
  const candidates = results
    .filter((item) => item.successRate > 0)
    .sort((left, right) => {
      if (right.successRate !== left.successRate) return right.successRate - left.successRate;
      const leftMedian = left.medianLatencyMs ?? Number.POSITIVE_INFINITY;
      const rightMedian = right.medianLatencyMs ?? Number.POSITIVE_INFINITY;
      if (leftMedian !== rightMedian) return leftMedian - rightMedian;
      const leftFirst = left.medianFirstTokenMs ?? Number.POSITIVE_INFINITY;
      const rightFirst = right.medianFirstTokenMs ?? Number.POSITIVE_INFINITY;
      if (leftFirst !== rightFirst) return leftFirst - rightFirst;
      return (left.avgLatencyMs ?? Number.POSITIVE_INFINITY) - (right.avgLatencyMs ?? Number.POSITIVE_INFINITY);
    });
  const best = candidates[0];
  if (!best) return null;
  const parts = [`${Math.round(best.successRate * 100)}% 成功率`];
  if (best.medianLatencyMs != null) parts.push(`中位耗时 ${best.medianLatencyMs}ms`);
  if (best.medianFirstTokenMs != null) parts.push(`首字中位 ${best.medianFirstTokenMs}ms`);
  return {
    modelName: best.modelName,
    reason: parts.join('，'),
  };
}

export async function diagnosticsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { targetType?: string; targetId?: string } }>('/api/diagnostics/credential', async (request, reply) => {
    const targetType = normalizeTargetType(request.query?.targetType);
    const targetId = normalizePositiveId(request.query?.targetId);
    if (!targetType || !targetId) {
      return reply.code(400).send({ success: false, message: 'targetType 或 targetId 无效' });
    }

    const target = await resolveDiagnosticTarget(targetType, targetId);
    if (!target) {
      return reply.code(404).send({ success: false, message: '诊断对象不存在' });
    }

    const adapter = getAdapter(target.site.platform);
    const visibleModels = await loadVisibleModels(target);
    const preferredModel = visibleModels.find((item) => !item.disabled)?.name || visibleModels[0]?.name || null;
    const [connectivityProbe, protocol, minimalProbe, routingImpact] = await Promise.all([
      runConnectivityProbe(target),
      runProtocolProbe(target, preferredModel),
      runMinimalModelProbe(target, preferredModel),
      loadRoutingImpact(target),
    ]);

    return {
      success: true,
      target: {
        type: target.type,
        site: {
          id: target.site.id,
          name: target.site.name,
          url: target.site.url,
          platform: target.site.platform,
          status: target.site.status,
        },
        account: target.account ? {
          id: target.account.id,
          username: target.account.username || null,
          status: target.account.status || null,
        } : null,
        token: target.token ? {
          id: target.token.id,
          name: target.token.name,
          enabled: !!target.token.enabled,
        } : null,
      },
      connectivity: {
        ...buildConnectivityPayload(target),
        probe: connectivityProbe,
      },
      protocol,
      models: {
        source: target.token ? 'token_model_availability' : (target.account ? 'account_model_availability' : 'site_probe_only'),
        total: visibleModels.length,
        recommendedBaseModel: preferredModel,
        items: visibleModels,
      },
      debug: minimalProbe,
      routing: {
        referencedRoutes: routingImpact.referencedRoutes.map((route) => ({
          ...route,
          decisionModelName: extractDecisionModelName(route.decisionSnapshot),
        })),
        governance: routingImpact.governance,
        downstreamKeys: routingImpact.downstreamKeys,
      },
      capability: {
        hasAdapter: !!adapter,
        canReadModels: !!target.account,
        canBenchmark: !!target.credential,
      },
    };
  });

  app.post<{ Body: { targetType?: string; targetId?: number | string; modelNames?: unknown; rounds?: number | string } }>('/api/diagnostics/credential/benchmark', async (request, reply) => {
    const targetType = normalizeTargetType(request.body?.targetType);
    const targetId = normalizePositiveId(request.body?.targetId);
    if (!targetType || !targetId) {
      return reply.code(400).send({ success: false, message: 'targetType 或 targetId 无效' });
    }

    const target = await resolveDiagnosticTarget(targetType, targetId);
    if (!target) {
      return reply.code(404).send({ success: false, message: '诊断对象不存在' });
    }
    if (!target.credential) {
      return reply.code(400).send({ success: false, message: '当前对象缺少可测速凭证' });
    }

    const inputModels = Array.isArray(request.body?.modelNames)
      ? request.body!.modelNames
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
      : [];
    const rounds = normalizeBenchmarkRounds(request.body?.rounds);
    const visibleModels = await loadVisibleModels(target);
    const candidateModels = (inputModels.length > 0 ? inputModels : visibleModels.map((item) => item.name))
      .filter(isBenchmarkCandidate)
      .slice(0, 12);

    const results: BenchmarkItem[] = [];
    for (const modelName of candidateModels) {
      const samples: BenchmarkSample[] = [];
      for (let index = 0; index < rounds; index += 1) {
        samples.push(await runBenchmarkRequest(target, modelName));
      }
      const successSamples = samples.filter((sample) => sample.ok);
      const elapsedValues = successSamples.map((sample) => sample.elapsedMs).filter((value): value is number => typeof value === 'number');
      const firstTokenValues = successSamples.map((sample) => sample.firstTokenMs).filter((value): value is number => typeof value === 'number');
      results.push({
        modelName,
        rounds,
        samples,
        successRate: rounds > 0 ? successSamples.length / rounds : 0,
        avgLatencyMs: average(elapsedValues),
        medianLatencyMs: median(elapsedValues),
        medianFirstTokenMs: median(firstTokenValues),
      });
    }

    const recommended = pickRecommendedBenchmark(results);
    return {
      success: true,
      rounds,
      target: {
        type: target.type,
        siteId: target.site.id,
        accountId: target.account?.id ?? null,
        tokenId: target.token?.id ?? null,
      },
      recommended,
      items: results,
    };
  });
}
