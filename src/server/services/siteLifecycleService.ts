export type SiteLifecycleHealthStatus = 'unknown' | 'alive' | 'unreachable';

export type SiteLifecycleAutoCheckinPolicy =
  | 'normal'
  | 'unsupported'
  | 'manual_required';

export type SiteLifecyclePhase =
  | 'active'
  | 'unreachable'
  | 'unsupported'
  | 'manual_required'
  | 'disabled';

type SiteLifecycleLike = {
  status?: string | null;
  healthStatus?: string | null;
  healthReason?: string | null;
  autoCheckinPolicy?: string | null;
  autoCheckinReason?: string | null;
};

export type NormalizedSiteLifecycle = {
  phase: SiteLifecyclePhase;
  enabled: boolean;
  reachable: boolean | null;
  routable: boolean;
  schedulableForCheckin: boolean;
  healthStatus: SiteLifecycleHealthStatus;
  autoCheckinPolicy: SiteLifecycleAutoCheckinPolicy;
  reason: string | null;
  routeBlockReason: string | null;
  checkinSkipReason: string | null;
};

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeSiteHealthStatus(value: unknown): SiteLifecycleHealthStatus {
  if (value === 'alive' || value === 'unreachable') return value;
  return 'unknown';
}

export function normalizeSiteAutoCheckinPolicy(value: unknown): SiteLifecycleAutoCheckinPolicy {
  if (value === 'unsupported' || value === 'manual_required') return value;
  return 'normal';
}

export function getSiteAutoCheckinPolicyReason(policy: SiteLifecycleAutoCheckinPolicy): string | null {
  switch (policy) {
    case 'unsupported':
      return '站点未提供签到接口，已永久跳过自动签到';
    case 'manual_required':
      return '站点需要人工验证，已永久跳过自动签到';
    case 'normal':
    default:
      return null;
  }
}

export function getNormalizedSiteLifecycle(site: SiteLifecycleLike): NormalizedSiteLifecycle {
  const siteStatus = trimText(site.status).toLowerCase() || 'active';
  const healthStatus = normalizeSiteHealthStatus(site.healthStatus);
  const autoCheckinPolicy = normalizeSiteAutoCheckinPolicy(site.autoCheckinPolicy);
  const healthReason = trimText(site.healthReason);
  const autoCheckinReason = trimText(site.autoCheckinReason);

  if (siteStatus === 'disabled') {
    const reason = healthReason || '站点已禁用';
    return {
      phase: 'disabled',
      enabled: false,
      reachable: false,
      routable: false,
      schedulableForCheckin: false,
      healthStatus,
      autoCheckinPolicy,
      reason,
      routeBlockReason: reason,
      checkinSkipReason: '站点已禁用',
    };
  }

  if (autoCheckinPolicy === 'unsupported') {
    const reason = autoCheckinReason || getSiteAutoCheckinPolicyReason('unsupported');
    return {
      phase: 'unsupported',
      enabled: true,
      reachable: healthStatus === 'alive' ? true : (healthStatus === 'unreachable' ? false : null),
      routable: healthStatus !== 'unreachable',
      schedulableForCheckin: false,
      healthStatus,
      autoCheckinPolicy,
      reason,
      routeBlockReason: healthStatus === 'unreachable' ? (healthReason || '站点当前不可达') : null,
      checkinSkipReason: reason,
    };
  }

  if (autoCheckinPolicy === 'manual_required') {
    const reason = autoCheckinReason || getSiteAutoCheckinPolicyReason('manual_required');
    return {
      phase: 'manual_required',
      enabled: true,
      reachable: healthStatus === 'alive' ? true : (healthStatus === 'unreachable' ? false : null),
      routable: healthStatus !== 'unreachable',
      schedulableForCheckin: false,
      healthStatus,
      autoCheckinPolicy,
      reason,
      routeBlockReason: healthStatus === 'unreachable' ? (healthReason || '站点当前不可达') : null,
      checkinSkipReason: reason,
    };
  }

  if (healthStatus === 'unreachable') {
    const reason = healthReason || '站点当前不可达';
    return {
      phase: 'unreachable',
      enabled: true,
      reachable: false,
      routable: false,
      schedulableForCheckin: false,
      healthStatus,
      autoCheckinPolicy,
      reason,
      routeBlockReason: reason,
      checkinSkipReason: '站点当前不可达，批量签到已临时跳过，恢复后会自动重新纳入',
    };
  }

  return {
    phase: 'active',
    enabled: true,
    reachable: healthStatus === 'alive' ? true : null,
    routable: true,
    schedulableForCheckin: true,
    healthStatus,
    autoCheckinPolicy,
    reason: null,
    routeBlockReason: null,
    checkinSkipReason: null,
  };
}

export function resolveSiteAutoCheckinSkip(site: SiteLifecycleLike): { message: string } | null {
  const lifecycle = getNormalizedSiteLifecycle(site);
  if (!lifecycle.checkinSkipReason) return null;
  return { message: lifecycle.checkinSkipReason };
}

export function isSiteReachableForRouting(site: SiteLifecycleLike): boolean {
  return getNormalizedSiteLifecycle(site).routable;
}

export function isSiteSchedulableForCheckin(site: SiteLifecycleLike): boolean {
  return getNormalizedSiteLifecycle(site).schedulableForCheckin;
}

