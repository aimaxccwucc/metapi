import type { CheckinResolution } from './failureReasonService.js';

export type SiteAutoCheckinPolicy =
  | 'normal'
  | 'unsupported'
  | 'manual_required';

type SiteAutoCheckinState = {
  healthStatus?: string | null;
  autoCheckinPolicy?: string | null;
  autoCheckinReason?: string | null;
};

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeSiteAutoCheckinPolicy(value: unknown): SiteAutoCheckinPolicy {
  if (value === 'unsupported' || value === 'manual_required') return value;
  return 'normal';
}

export function getSiteAutoCheckinPolicyReason(policy: SiteAutoCheckinPolicy): string | null {
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

export function resolveSiteAutoCheckinSkip(site: SiteAutoCheckinState): { message: string } | null {
  const policy = normalizeSiteAutoCheckinPolicy(site.autoCheckinPolicy);
  const storedReason = trimText(site.autoCheckinReason);

  if (policy !== 'normal') {
    return {
      message: storedReason || getSiteAutoCheckinPolicyReason(policy) || '站点已永久跳过自动签到',
    };
  }

  if (trimText(site.healthStatus) === 'unreachable') {
    return {
      message: '站点当前不可达，批量签到已临时跳过，恢复后会自动重新纳入',
    };
  }

  return null;
}

export function deriveSiteAutoCheckinPolicyUpdate(
  resolution: Pick<CheckinResolution, 'code' | 'logMessage'>,
): { policy: SiteAutoCheckinPolicy; reason: string } | null {
  switch (resolution.code) {
    case 'checkin_not_supported':
      return {
        policy: 'unsupported',
        reason: trimText(resolution.logMessage) || (getSiteAutoCheckinPolicyReason('unsupported') as string),
      };
    case 'manual_turnstile_required':
      return {
        policy: 'manual_required',
        reason: trimText(resolution.logMessage) || (getSiteAutoCheckinPolicyReason('manual_required') as string),
      };
    default:
      return null;
  }
}
