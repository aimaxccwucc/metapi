import { describe, expect, it } from 'vitest';
import {
  getNormalizedSiteLifecycle,
  getSiteAutoCheckinPolicyReason,
  isSiteReachableForRouting,
  isSiteSchedulableForCheckin,
  normalizeSiteAutoCheckinPolicy,
  normalizeSiteHealthStatus,
  resolveSiteAutoCheckinSkip,
} from './siteLifecycleService.js';

describe('siteLifecycleService', () => {
  it('treats unreachable sites as temporarily skipped for checkin and unroutable', () => {
    const lifecycle = getNormalizedSiteLifecycle({
      status: 'active',
      healthStatus: 'unreachable',
      healthReason: 'dial tcp timeout',
      autoCheckinPolicy: 'normal',
    });

    expect(lifecycle.phase).toBe('unreachable');
    expect(lifecycle.routable).toBe(false);
    expect(lifecycle.schedulableForCheckin).toBe(false);
    expect(resolveSiteAutoCheckinSkip({
      status: 'active',
      healthStatus: 'unreachable',
      autoCheckinPolicy: 'normal',
    })).toEqual({
      message: '站点当前不可达，批量签到已临时跳过，恢复后会自动重新纳入',
    });
  });

  it('treats manual_required and unsupported as permanent checkin skip but still routable when reachable', () => {
    const manual = getNormalizedSiteLifecycle({
      status: 'active',
      healthStatus: 'alive',
      autoCheckinPolicy: 'manual_required',
    });
    const unsupported = getNormalizedSiteLifecycle({
      status: 'active',
      healthStatus: 'alive',
      autoCheckinPolicy: 'unsupported',
    });

    expect(manual.phase).toBe('manual_required');
    expect(manual.routable).toBe(true);
    expect(manual.schedulableForCheckin).toBe(false);
    expect(unsupported.phase).toBe('unsupported');
    expect(unsupported.routable).toBe(true);
    expect(unsupported.schedulableForCheckin).toBe(false);
  });

  it('treats disabled sites as non-routable and non-schedulable', () => {
    expect(isSiteReachableForRouting({
      status: 'disabled',
      healthStatus: 'alive',
      autoCheckinPolicy: 'normal',
    })).toBe(false);
    expect(isSiteSchedulableForCheckin({
      status: 'disabled',
      healthStatus: 'alive',
      autoCheckinPolicy: 'normal',
    })).toBe(false);
  });

  it('normalizes unknown statuses conservatively', () => {
    expect(normalizeSiteHealthStatus('weird')).toBe('unknown');
    expect(normalizeSiteAutoCheckinPolicy('weird')).toBe('normal');
    expect(getSiteAutoCheckinPolicyReason('normal')).toBeNull();
  });
});
