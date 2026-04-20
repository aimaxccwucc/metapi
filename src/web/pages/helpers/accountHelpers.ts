/**
 * Shared pure helper functions for account-related logic.
 * Extracted from Accounts.tsx for reuse by SiteAccountsModal.
 */

// ── Form factories ──────────────────────────────────────────────────

export function createLoginForm() {
  return { siteId: 0, username: '', password: '' };
}

export function createTokenForm(credentialMode: 'session' | 'apikey' = 'session') {
  return {
    siteId: 0,
    username: '',
    accessToken: '',
    accessTokens: '',
    platformUserId: '',
    refreshToken: '',
    tokenExpiresAt: '',
    credentialMode,
    skipModelFetch: false,
  };
}

export function createRebindForm(platformUserId = '') {
  return { accessToken: '', platformUserId, refreshToken: '', tokenExpiresAt: '' };
}

// ── Credential / capability helpers ──────────────────────────────────

export function resolveAccountCredentialMode(account: any): 'session' | 'apikey' {
  const rawMode = String(account?.credentialMode || '').trim().toLowerCase();
  if (rawMode === 'apikey') return 'apikey';
  if (rawMode === 'session') return 'session';
  const fromServer = account?.capabilities;
  if (fromServer && typeof fromServer.proxyOnly === 'boolean') {
    return fromServer.proxyOnly ? 'apikey' : 'session';
  }
  const hasSession = typeof account?.accessToken === 'string' && account.accessToken.trim().length > 0;
  return hasSession ? 'session' : 'apikey';
}

export function resolveAccountCapabilities(account: any) {
  const fromServer = account?.capabilities;
  if (fromServer && typeof fromServer === 'object') {
    return {
      canCheckin: !!fromServer.canCheckin,
      canRefreshBalance: !!fromServer.canRefreshBalance,
      proxyOnly: !!fromServer.proxyOnly,
    };
  }
  const hasSession = typeof account?.accessToken === 'string' && account.accessToken.trim().length > 0;
  return {
    canCheckin: hasSession,
    canRefreshBalance: hasSession,
    proxyOnly: !hasSession,
  };
}

export function resolveAccountDisplayName(account: any) {
  const username = typeof account?.username === 'string' ? account.username.trim() : '';
  if (username) return username;
  return resolveAccountCredentialMode(account) === 'apikey' ? 'API Key 连接' : '未命名';
}

// ── Extra config parsing ─────────────────────────────────────────────

const extraConfigCache = new WeakMap<any, Record<string, any>>();

export function parseAccountExtraConfig(account: any): Record<string, any> {
  try { return JSON.parse(account?.extraConfig || '{}') || {}; }
  catch { return {}; }
}

export function cachedParseExtraConfig(account: any): Record<string, any> {
  const cached = extraConfigCache.get(account);
  if (cached) return cached;
  const parsed = parseAccountExtraConfig(account);
  extraConfigCache.set(account, parsed);
  return parsed;
}

export function extractManagedSub2ApiAuth(account: any) {
  const parsed = cachedParseExtraConfig(account);
  const auth = parsed?.sub2apiAuth || {};
  return {
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    tokenExpiresAt: auth.tokenExpiresAt ? String(auth.tokenExpiresAt) : '',
  };
}

export function extractPlatformUserId(account: any): string {
  const parsed = parseAccountExtraConfig(account);
  const raw = parsed?.platformUserId;
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(value) && value > 0) return String(value);
  const guessed = Number.parseInt(String(account?.username || '').match(/(\d{3,8})$/)?.[1] || '', 10);
  return Number.isFinite(guessed) && guessed > 0 ? String(guessed) : '';
}

// ── Runtime health ───────────────────────────────────────────────────

export function getRuntimeHealthState(account: any) {
  if (account?.runtimeHealth?.state) return account.runtimeHealth.state;
  const proxyOnly = typeof account?.capabilities?.proxyOnly === 'boolean'
    ? !!account.capabilities.proxyOnly
    : !(typeof account?.accessToken === 'string' && account.accessToken.trim().length > 0);
  if (account?.status === 'disabled' || account?.site?.status === 'disabled') return 'disabled';
  if (!proxyOnly && account?.status === 'expired') return 'unhealthy';
  return 'unknown';
}

export function getRuntimeHealthSortRank(account: any) {
  const state = getRuntimeHealthState(account);
  switch (state) {
    case 'healthy': return 4;
    case 'degraded': return 3;
    case 'unknown': return 2;
    case 'unhealthy': return 1;
    case 'disabled':
    default: return 0;
  }
}

export const runtimeHealthMap: Record<string, {
  label: string;
  cls: string;
  dotClass: string;
  pulse: boolean;
}> = {
  healthy: { label: '健康', cls: 'badge-success', dotClass: 'status-dot-success', pulse: true },
  unhealthy: { label: '异常', cls: 'badge-error', dotClass: 'status-dot-error', pulse: true },
  degraded: { label: '降级', cls: 'badge-warning', dotClass: 'status-dot-pending', pulse: true },
  disabled: { label: '已禁用', cls: 'badge-muted', dotClass: 'status-dot-muted', pulse: false },
  unknown: { label: '未知', cls: 'badge-muted', dotClass: 'status-dot-pending', pulse: false },
};

export function resolveRuntimeHealth(account: any) {
  const capabilities = resolveAccountCapabilities(account);
  const fallbackState = account.status === 'disabled' || account.site?.status === 'disabled'
    ? 'disabled'
    : (!capabilities.proxyOnly && account.status === 'expired' ? 'unhealthy' : 'unknown');
  const state = account.runtimeHealth?.state || fallbackState;
  const cfg = runtimeHealthMap[state] || runtimeHealthMap.unknown;
  const reason = account.runtimeHealth?.reason
    || (state === 'disabled'
      ? '账号或站点已禁用'
      : (state === 'unhealthy' ? '最近健康检查失败' : '尚未获取运行健康信息'));
  return { state, reason, ...cfg };
}

// ── Auto checkin ─────────────────────────────────────────────────────

export function resolveAccountAutoCheckin(account: any, capabilities: { canCheckin: boolean; proxyOnly: boolean }) {
  const site = account?.site || {};
  const storedReason = typeof site.autoCheckinReason === 'string' ? site.autoCheckinReason.trim() : '';

  if (!capabilities.canCheckin) {
    return {
      label: '不参与',
      cls: 'badge-muted',
      reason: '当前连接仅用于 API Key 代理，不参与签到',
    };
  }

  if (account?.checkinEnabled === false) {
    return {
      label: '账号关闭',
      cls: 'badge-muted',
      reason: '账号已关闭签到，批量签到会忽略此账号',
    };
  }

  if (site.status === 'disabled') {
    return {
      label: '站点禁用',
      cls: 'badge-muted',
      reason: '站点已禁用，批量签到不会执行',
    };
  }

  if (site.autoCheckinPolicy === 'unsupported') {
    return {
      label: '永久跳过',
      cls: 'badge-warning',
      reason: storedReason || '站点未提供签到接口，已永久跳过自动签到',
    };
  }

  if (site.autoCheckinPolicy === 'manual_required') {
    return {
      label: '人工处理',
      cls: 'badge-warning',
      reason: storedReason || '站点需要人工验证，已永久跳过自动签到',
    };
  }

  if ((site.healthStatus || 'unknown') === 'unreachable') {
    return {
      label: '临时跳过',
      cls: 'badge-error',
      reason: '站点当前不可达，批量签到会临时跳过；恢复可达后会自动重新纳入',
    };
  }

  return {
    label: '正常参与',
    cls: 'badge-success',
    reason: '当前参与批量签到',
  };
}

export function resolveCheckinAttentionReason(account: any): string {
  const snapshot = account?.checkinSnapshot;
  const reasonCode = typeof snapshot?.reasonCode === 'string' ? snapshot.reasonCode.trim() : '';
  const message = typeof snapshot?.message === 'string' ? snapshot.message.trim() : '';
  if (reasonCode && message) return `${reasonCode}: ${message}`;
  if (message) return message;
  if (reasonCode) return reasonCode;
  return '';
}

// ── Manual checkin helpers ───────────────────────────────────────────

export function resolveManualCheckinUrl(account: any): string {
  const externalCheckinUrl = typeof account?.site?.externalCheckinUrl === 'string'
    ? account.site.externalCheckinUrl.trim()
    : '';
  if (externalCheckinUrl) return externalCheckinUrl;
  const siteUrl = typeof account?.site?.url === 'string' ? account.site.url.trim() : '';
  return siteUrl;
}

export function canOpenManualCheckin(account: any): boolean {
  return resolveManualCheckinUrl(account).length > 0;
}

export function resolveManualSiteUrl(account: any): string {
  return typeof account?.site?.url === 'string' ? account.site.url.trim() : '';
}

// ── Model helpers ────────────────────────────────────────────────────

export function formatModelSuccess(refresh: any) {
  const models = Array.isArray(refresh?.modelsPreview) ? refresh.modelsPreview : [];
  const count = Number.isFinite(refresh?.modelCount) ? refresh.modelCount : models.length;
  if (models.length === 0) return `已获取到模型（共 ${count} 个）`;
  const preview = models.slice(0, 6).join('、');
  const suffix = `（共 ${count} 个）`;
  return `已获取到模型：${preview}${suffix}`;
}

export function formatModelFailure(refresh: any, messageFallback?: string) {
  const code = refresh?.errorCode;
  if (code === 'timeout') return '模型获取失败（请求超时）';
  if (code === 'unauthorized') return '模型获取失败，API Key 已无效';
  if (code === 'empty_models') return '模型获取失败：未获取到可用模型';
  return messageFallback || refresh?.errorMessage || '模型获取失败';
}

// ── Utility helpers ──────────────────────────────────────────────────

export function countBatchApiKeys(input: string): number {
  return String(input || '').trim().split(/[\s,，;\n\r\t]+/g).filter(Boolean).length;
}

export function maskCredentialPreview(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '-';
  if (normalized.length <= 10) return normalized;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

export function isTruthyFlag(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function parsePositiveInt(value: string | null): number {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function copyText(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === 'undefined' || !document.body) {
    throw new Error('clipboard unavailable');
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function openExternalUrl(url: string): 'popup' | 'anchor' | 'same-tab' | 'failed' {
  if (!url || typeof window === 'undefined') return 'failed';

  try {
    if (typeof window.open === 'function') {
      const popup = window.open(url, '_blank', 'noopener,noreferrer');
      if (popup) return 'popup';
    }
  } catch {
    // Fallbacks below cover environments that block window.open.
  }

  try {
    if (typeof document !== 'undefined' && document.body && typeof document.createElement === 'function') {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.position = 'fixed';
      link.style.left = '-9999px';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return 'anchor';
    }
  } catch {
    // Final fallback uses same-tab navigation.
  }

  try {
    if (typeof window.location?.assign === 'function') {
      window.location.assign(url);
      return 'same-tab';
    }
  } catch {
    // Swallow and report failure below.
  }

  return 'failed';
}

// ── Diagnostic path builder ──────────────────────────────────────────

export function buildDiagnosticPath(targetType: 'site' | 'account' | 'token', targetId: number): string {
  const params = new URLSearchParams();
  params.set('targetType', targetType);
  params.set('targetId', String(targetId));
  return `/diagnostics?${params.toString()}`;
}
