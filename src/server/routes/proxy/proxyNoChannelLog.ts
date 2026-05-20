import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { insertProxyLogBestEffort } from '../../services/proxyLogStore.js';
import { tokenRouter, type RouteDecisionCandidate } from '../../services/tokenRouter.js';
import type { DownstreamRoutingPolicy } from '../../services/downstreamPolicyTypes.js';
import type { DownstreamClientContext } from './downstreamClientContext.js';
import { composeProxyLogMessage } from './logPathMeta.js';

const NO_CHANNEL_DIAGNOSTIC_TIMEOUT_MS = 200;

function summarizeNoChannelDecision(candidates: RouteDecisionCandidate[]): string | null {
  if (candidates.length === 0) return null;

  const counters = new Map<string, number>();
  const add = (label: string, enabled = true) => {
    if (!enabled) return;
    counters.set(label, (counters.get(label) || 0) + 1);
  };

  for (const candidate of candidates) {
    add('可用候选', candidate.eligible);
    add('最近失败', candidate.avoidedByRecentFailure || candidate.recentlyFailed);
    add('通道租约', !!candidate.avoidedByInflightLease);
    add('账号预算/并发', !!candidate.avoidedByAccountLease);
    add('站点已尝试', !!candidate.avoidedByAttemptedSite);
    add('运行时熔断', !!(candidate.circuitStatus?.isOpen || candidate.siteRuntimeState?.globalBreakerOpen || candidate.siteRuntimeState?.modelBreakerOpen));
    add('模型熔断', !!candidate.modelCircuitStatus?.isOpen);
    add('冷却中', !!candidate.cooldownUntil);
    add('治理抑制', candidate.governanceAction === 'suppressed');
    add('无令牌', /令牌不可用/.test(candidate.reason || ''));
    add('账号/站点不可用', /(账号状态|站点状态|站点健康|运行时健康=disabled|运行时健康=unhealthy)/.test(candidate.reason || ''));
    add('来源模型不匹配', /来源模型不匹配/.test(candidate.reason || ''));
    add('模型能力不可用', /(模型能力已标记不可用|模型能力未验证且近期失败)/.test(candidate.reason || ''));
  }

  const parts = Array.from(counters.entries())
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hans-CN'))
    .slice(0, 6)
    .map(([label, count]) => `${label}${count}`);

  return parts.length > 0 ? parts.join('，') : null;
}

async function buildNoChannelDiagnostic(
  modelRequested: string,
  downstreamPolicy?: DownstreamRoutingPolicy | null,
): Promise<string | null> {
  const model = modelRequested.trim();
  if (!model) return null;
  try {
    const decision = downstreamPolicy
      ? await tokenRouter.explainSelection(model, [], downstreamPolicy)
      : await tokenRouter.explainSelection(model);
    if (!decision.matched) return '路由诊断：未匹配启用路由';
    const summary = summarizeNoChannelDecision(decision.candidates);
    const routeText = decision.routeId ? `路由#${decision.routeId}` : '已匹配路由';
    const candidateText = `候选${decision.candidates.length}`;
    const selectedText = decision.selectedChannelId ? `可选通道#${decision.selectedChannelId}` : '无可选通道';
    return `路由诊断：${routeText}，${candidateText}，${selectedText}${summary ? `，${summary}` : ''}`;
  } catch (error) {
    console.warn('[proxy] failed to build no-channel diagnostic', error);
    return null;
  }
}

async function buildNoChannelDiagnosticFastWait(
  modelRequested: string,
  downstreamPolicy?: DownstreamRoutingPolicy | null,
): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      buildNoChannelDiagnostic(modelRequested, downstreamPolicy),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), NO_CHANNEL_DIAGNOSTIC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function logProxyNoChannelFailure(input: {
  modelRequested: string;
  httpStatus: number;
  errorMessage: string;
  retryCount: number;
  downstreamPath: string;
  upstreamPath?: string | null;
  clientContext?: DownstreamClientContext | null;
  downstreamApiKeyId?: number | null;
  downstreamPolicy?: DownstreamRoutingPolicy | null;
}): void {
  void (async () => {
    const diagnostic = await buildNoChannelDiagnosticFastWait(input.modelRequested, input.downstreamPolicy);
    const errorMessage = diagnostic
      ? `${input.errorMessage}；${diagnostic}`
      : input.errorMessage;
    insertProxyLogBestEffort({
      routeId: null,
      channelId: null,
      accountId: null,
      downstreamApiKeyId: input.downstreamApiKeyId ?? null,
      modelRequested: input.modelRequested,
      modelActual: null,
      status: 'failed',
      httpStatus: input.httpStatus,
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      clientFamily: input.clientContext?.clientKind || null,
      clientAppId: input.clientContext?.clientAppId || null,
      clientAppName: input.clientContext?.clientAppName || null,
      clientConfidence: input.clientContext?.clientConfidence || null,
      errorMessage: composeProxyLogMessage({
        clientKind: input.clientContext?.clientKind && input.clientContext.clientKind !== 'generic'
          ? input.clientContext.clientKind
          : null,
        sessionId: input.clientContext?.sessionId || null,
        traceHint: input.clientContext?.traceHint || null,
        downstreamPath: input.downstreamPath,
        upstreamPath: input.upstreamPath || null,
        errorMessage,
      }),
      retryCount: input.retryCount,
      createdAt: formatUtcSqlDateTime(new Date()),
    });
  })().catch((error) => {
    console.warn('[proxy] failed to write no-channel proxy log', error);
  });
}
