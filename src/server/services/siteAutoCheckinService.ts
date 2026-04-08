import type { CheckinResolution } from './failureReasonService.js';
import {
  getSiteAutoCheckinPolicyReason,
  normalizeSiteAutoCheckinPolicy,
  type SiteLifecycleAutoCheckinPolicy as SiteAutoCheckinPolicy,
} from './siteLifecycleService.js';

export {
  getSiteAutoCheckinPolicyReason,
  normalizeSiteAutoCheckinPolicy,
};

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
