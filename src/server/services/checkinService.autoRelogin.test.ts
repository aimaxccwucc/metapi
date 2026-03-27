import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  checkin: vi.fn(),
  login: vi.fn(),
};

const notifyMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const refreshBalanceMock = vi.fn();
const decryptPasswordMock = vi.fn();
const getCheckinSiteBackoffDecisionMock = vi.fn();
const recordCheckinSiteResolutionMock = vi.fn();

const selectAllMock = vi.fn();
const insertValuesMock = vi.fn();
const updateSetMock = vi.fn();

vi.mock('../db/index.js', () => {
  const selectChain = {
    all: () => selectAllMock(),
    where: () => selectChain,
    innerJoin: () => selectChain,
    from: () => selectChain,
  };

  const fromChain = {
    innerJoin: () => fromChain,
    where: () => fromChain,
    all: () => selectAllMock(),
  };

  const insertChain = {
    run: () => ({}),
    values: (...args: unknown[]) => {
      insertValuesMock(...args);
      return insertChain;
    },
  };

  const updateWhereChain = {
    run: () => ({}),
  };

  const updateSetChain = {
    where: () => updateWhereChain,
  };

  return {
    db: {
      select: () => ({
        from: () => fromChain,
        where: () => selectChain,
        innerJoin: () => selectChain,
        all: () => selectAllMock(),
      }),
      insert: () => insertChain,
      update: () => ({
        set: (updates: Record<string, unknown>) => {
          updateSetMock(updates);
          return updateSetChain;
        },
      }),
    },
    schema: {
      accounts: { id: 'id', siteId: 'siteId', checkinEnabled: 'checkinEnabled', status: 'status' },
      sites: { id: 'id' },
      checkinLogs: {},
      events: {},
    },
  };
});

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => adapterMock,
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => notifyMock(...args),
}));

vi.mock('./alertService.js', () => ({
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('./balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPassword: (...args: unknown[]) => decryptPasswordMock(...args),
}));

vi.mock('./checkinSiteRuntime.js', () => ({
  getCheckinSiteBackoffDecision: (...args: unknown[]) => getCheckinSiteBackoffDecisionMock(...args),
  recordCheckinSiteResolution: (...args: unknown[]) => recordCheckinSiteResolutionMock(...args),
}));

describe('checkinService auto relogin', () => {
  beforeEach(() => {
    adapterMock.checkin.mockReset();
    adapterMock.login.mockReset();
    notifyMock.mockReset();
    reportTokenExpiredMock.mockReset();
    refreshBalanceMock.mockReset();
    decryptPasswordMock.mockReset();
    getCheckinSiteBackoffDecisionMock.mockReset();
    recordCheckinSiteResolutionMock.mockReset();
    selectAllMock.mockReset();
    insertValuesMock.mockReset();
    updateSetMock.mockReset();
    getCheckinSiteBackoffDecisionMock.mockResolvedValue({
      siteId: 0,
      blocked: false,
      blockedUntilMs: null,
      blockedUntil: null,
      failureStreak: 0,
      lastReasonCode: null,
      lastMessage: null,
    });
    recordCheckinSiteResolutionMock.mockResolvedValue(undefined);
  });

  it('retries checkin once after auto relogin when access token is missing', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 1,
          username: 'linuxdo_7659',
          accessToken: 'expired-token',
          status: 'active',
          extraConfig: JSON.stringify({
            autoRelogin: { username: 'linuxdo_7659', passwordCipher: 'cipher' },
          }),
        },
        sites: {
          id: 3,
          name: 'kfc',
          url: 'https://kfc-api.sxxe.net',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin
      .mockResolvedValueOnce({ success: false, message: '无权进行此操作，未登录且未提供 access token' })
      .mockResolvedValueOnce({ success: true, message: 'checked in' });
    decryptPasswordMock.mockReturnValue('plain-password');
    adapterMock.login.mockResolvedValue({ success: true, accessToken: 'fresh-token' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(1);

    expect(result.success).toBe(true);
    expect(adapterMock.login).toHaveBeenCalledTimes(1);
    expect(adapterMock.checkin).toHaveBeenCalledTimes(2);
    expect(adapterMock.checkin.mock.calls[0][1]).toBe('expired-token');
    expect(adapterMock.checkin.mock.calls[1][1]).toBe('fresh-token');
    expect(adapterMock.checkin.mock.calls[0][2]).toBe(7659);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh-token' }));
  });

  it('passes guessed platform user id when config does not include it', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 2,
          username: 'linuxdo_11494',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 4,
          name: 'wong',
          url: 'https://wzw.pp.ua',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: 'checked in' });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(2);

    expect(adapterMock.checkin).toHaveBeenCalledTimes(1);
    expect(adapterMock.checkin.mock.calls[0][2]).toBe(11494);
  });

  it('keeps successful checkin as success when message is 签到成功', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 12,
          username: 'linuxdo_5566',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 12,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: '签到成功' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(12);

    expect(result.success).toBe(true);
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('success');
  });

  it('infers reward from balance delta when checkin reward text is empty', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 13,
          username: 'linuxdo_7788',
          accessToken: 'token',
          status: 'active',
          balance: 10,
          extraConfig: null,
        },
        sites: {
          id: 13,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: 'checkin success' });
    refreshBalanceMock.mockResolvedValue({ balance: 12.5, used: 0, quota: 12.5 });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(13);

    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Number(firstInsertPayload?.reward)).toBeCloseTo(2.5, 6);
  });

  it('treats already checked in responses as successful checkins', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 9,
          username: 'linuxdo_9999',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 9,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: false, message: '今天已经签到过啦' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9);

    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('success');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does not advance lastCheckinAt for already checked in responses in interval mode', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 16,
          username: 'interval-user',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 16,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: false, message: '今天已经签到过啦' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(16, { scheduleMode: 'interval' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    expect(updateSetMock).not.toHaveBeenCalledWith(expect.objectContaining({ lastCheckinAt: expect.any(String) }));
  });

  it('advances lastCheckinAt when interval mode gets a direct success', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 17,
          username: 'interval-success',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 17,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: '签到成功' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(17, { scheduleMode: 'interval' });

    expect(result.success).toBe(true);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ lastCheckinAt: expect.any(String) }));
  });

  it('treats unsupported checkin endpoint responses as skipped', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 10,
          username: 'linuxdo_131936',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 10,
          name: 'anyrouter',
          url: 'https://anyrouter.top',
          platform: 'anyrouter',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'HTTP 404: {"error":{"message":"Invalid URL (POST /api/user/checkin)"}}',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(10);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    expect(result.reasonCode).toBe('checkin_not_supported');
    expect(result.checkinSnapshotStatus).toBe('unsupported');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(updateSetMock.mock.calls.some((call) => (
      typeof call?.[0]?.extraConfig === 'string'
      && call[0].extraConfig.includes('"checkinSnapshot"')
    ))).toBe(true);
  });

  it('skips account updates when unsupported checkin responses do not change account state', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 18,
          username: 'plain-user',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 18,
          name: 'done-hub',
          url: 'https://done.example.com',
          platform: 'donehub',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'checkin endpoint not found',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(18);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      extraConfig: expect.stringContaining('"checkinSnapshot"'),
    }));
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
  });

  it('treats sub2api checkin unsupported message as skipped', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 15,
          username: 'sub2_user',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 15,
          name: 'sub2',
          url: 'https://sub2.example.com',
          platform: 'sub2api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'Check-in is not supported by Sub2API',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(15);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('treats turnstile-required responses as skipped', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 14,
          username: 'linuxdo_10277',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 14,
          name: 'run-anytime',
          url: 'https://runanytime.hxi.me',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'Turnstile token 为空',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(14);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    expect(result.reasonCode).toBe('manual_turnstile_required');
    expect(result.checkinSnapshotStatus).toBe('manual_required');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
    expect(firstInsertPayload?.message).toBe('站点开启了 Turnstile 校验，需要人工签到');
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('records site runtime outcome after failed and successful checkins', async () => {
    selectAllMock
      .mockReturnValueOnce([
        {
          accounts: {
            id: 24,
            username: 'runtime-user',
            accessToken: 'token',
            status: 'active',
            extraConfig: null,
          },
          sites: {
            id: 34,
            name: 'runtime-site',
            url: 'https://runtime.example.com',
            platform: 'new-api',
          },
        },
      ])
      .mockReturnValueOnce([
        {
          accounts: {
            id: 24,
            username: 'runtime-user',
            accessToken: 'token',
            status: 'active',
            extraConfig: null,
          },
          sites: {
            id: 34,
            name: 'runtime-site',
            url: 'https://runtime.example.com',
            platform: 'new-api',
          },
        },
      ]);

    adapterMock.checkin
      .mockResolvedValueOnce({ success: false, message: 'HTTP 500: upstream error' })
      .mockResolvedValueOnce({ success: true, message: 'checked in' });

    const { checkinAccount } = await import('./checkinService.js');

    await checkinAccount(24, { scheduleMode: 'cron' });
    await checkinAccount(24, { scheduleMode: 'cron' });

    expect(recordCheckinSiteResolutionMock).toHaveBeenCalledTimes(2);
    expect(recordCheckinSiteResolutionMock.mock.calls[0]?.[0]).toBe(34);
    expect(recordCheckinSiteResolutionMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      lifecycle: 'failed',
      checkinSnapshotStatus: 'retryable_failed',
      code: 'upstream_error',
    }));
    expect(recordCheckinSiteResolutionMock.mock.calls[1]?.[0]).toBe(34);
    expect(recordCheckinSiteResolutionMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      lifecycle: 'completed',
      checkinSnapshotStatus: 'success',
    }));
  });

  it('does not increase site runtime budget for manual-required or unsupported checkins', async () => {
    selectAllMock
      .mockReturnValueOnce([
        {
          accounts: {
            id: 25,
            username: 'manual-user',
            accessToken: 'token',
            status: 'active',
            extraConfig: null,
          },
          sites: {
            id: 35,
            name: 'manual-site',
            url: 'https://manual.example.com',
            platform: 'new-api',
          },
        },
      ])
      .mockReturnValueOnce([
        {
          accounts: {
            id: 26,
            username: 'unsupported-user',
            accessToken: 'token',
            status: 'active',
            extraConfig: null,
          },
          sites: {
            id: 36,
            name: 'unsupported-site',
            url: 'https://unsupported.example.com',
            platform: 'new-api',
          },
        },
      ]);

    adapterMock.checkin
      .mockResolvedValueOnce({ success: false, message: 'Turnstile token 为空' })
      .mockResolvedValueOnce({ success: false, message: 'checkin endpoint not found' });

    const { checkinAccount } = await import('./checkinService.js');

    await checkinAccount(25, { scheduleMode: 'cron' });
    await checkinAccount(26, { scheduleMode: 'cron' });

    expect(recordCheckinSiteResolutionMock).toHaveBeenCalledTimes(2);
    expect(recordCheckinSiteResolutionMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      lifecycle: 'skipped',
      requiresManual: true,
      checkinSnapshotStatus: 'manual_required',
    }));
    expect(recordCheckinSiteResolutionMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      lifecycle: 'skipped',
      unsupported: true,
      checkinSnapshotStatus: 'unsupported',
    }));
  });

  it('includes expired accounts in batch checkin so auto relogin can recover them', async () => {
    selectAllMock
      .mockReturnValueOnce([
        {
          accounts: {
            id: 21,
            username: 'expired_user',
            accessToken: 'stale-token',
            status: 'expired',
            checkinEnabled: true,
            extraConfig: JSON.stringify({
              autoRelogin: { username: 'expired_user', passwordCipher: 'cipher' },
            }),
          },
          sites: {
            id: 21,
            name: 'demo',
            url: 'https://example.com',
            platform: 'new-api',
          },
        },
      ])
      .mockReturnValueOnce([
        {
          accounts: {
            id: 21,
            username: 'expired_user',
            accessToken: 'stale-token',
            status: 'expired',
            extraConfig: JSON.stringify({
              autoRelogin: { username: 'expired_user', passwordCipher: 'cipher' },
            }),
          },
          sites: {
            id: 21,
            name: 'demo',
            url: 'https://example.com',
            platform: 'new-api',
          },
        },
      ]);

    adapterMock.checkin
      .mockResolvedValueOnce({ success: false, message: 'access token expired' })
      .mockResolvedValueOnce({ success: true, message: 'checked in' });
    decryptPasswordMock.mockReturnValue('plain-password');
    adapterMock.login.mockResolvedValue({ success: true, accessToken: 'fresh-token' });

    const { checkinAll } = await import('./checkinService.js');
    const results = await checkinAll({ scheduleMode: 'cron' });

    expect(results).toHaveLength(1);
    expect(results[0]?.result?.success).toBe(true);
    expect(adapterMock.login).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'fresh-token',
      status: 'active',
    }));
  });

  it('skips all accounts on a site when site-level checkin backoff is active', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 31,
          username: 'blocked-a',
          accessToken: 'token-a',
          status: 'active',
          checkinEnabled: true,
          extraConfig: null,
        },
        sites: {
          id: 41,
          name: 'blocked-site',
          url: 'https://blocked.example.com',
          platform: 'new-api',
        },
      },
      {
        accounts: {
          id: 32,
          username: 'blocked-b',
          accessToken: 'token-b',
          status: 'active',
          checkinEnabled: true,
          extraConfig: null,
        },
        sites: {
          id: 41,
          name: 'blocked-site',
          url: 'https://blocked.example.com',
          platform: 'new-api',
        },
      },
    ]);
    getCheckinSiteBackoffDecisionMock.mockResolvedValue({
      siteId: 41,
      blocked: true,
      blockedUntilMs: Date.parse('2026-03-28T00:00:00.000Z'),
      blockedUntil: '2026-03-28T00:00:00.000Z',
      failureStreak: 3,
      lastReasonCode: 'upstream_error',
      lastMessage: 'site checkin backoff active',
    });

    const { checkinAll } = await import('./checkinService.js');
    const results = await checkinAll({ scheduleMode: 'cron' });

    expect(results).toHaveLength(2);
    expect(adapterMock.checkin).not.toHaveBeenCalled();
    expect(results.every((item) => item.result?.status === 'skipped' && item.result?.skipped === true)).toBe(true);
    expect(results[0]?.result?.reasonCode).toBe('upstream_error');
    expect(results[0]?.result?.failureStreak).toBe(3);
    expect(recordCheckinSiteResolutionMock).not.toHaveBeenCalled();
  });

  it('keeps batch checkin isolated when one account throws unexpectedly', async () => {
    selectAllMock
      .mockReturnValueOnce([
        {
          accounts: {
            id: 22,
            username: 'bad-user',
            accessToken: 'token-a',
            status: 'active',
            checkinEnabled: true,
            extraConfig: null,
          },
          sites: {
            id: 31,
            name: 'site-a',
            url: 'https://a.example.com',
            platform: 'new-api',
          },
        },
        {
          accounts: {
            id: 23,
            username: 'good-user',
            accessToken: 'token-b',
            status: 'active',
            checkinEnabled: true,
            extraConfig: null,
          },
          sites: {
            id: 31,
            name: 'site-a',
            url: 'https://a.example.com',
            platform: 'new-api',
          },
        },
      ])
      .mockReturnValueOnce([
        {
          accounts: {
            id: 22,
            username: 'bad-user',
            accessToken: 'token-a',
            status: 'active',
            extraConfig: null,
          },
          sites: {
            id: 31,
            name: 'site-a',
            url: 'https://a.example.com',
            platform: 'new-api',
          },
        },
      ])
      .mockReturnValueOnce([
        {
          accounts: {
            id: 23,
            username: 'good-user',
            accessToken: 'token-b',
            status: 'active',
            extraConfig: null,
          },
          sites: {
            id: 31,
            name: 'site-a',
            url: 'https://a.example.com',
            platform: 'new-api',
          },
        },
      ]);

    adapterMock.checkin
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ success: true, message: 'checked in' });

    const { checkinAll } = await import('./checkinService.js');
    const results = await checkinAll({ scheduleMode: 'cron' });

    expect(results).toHaveLength(2);
    expect(results[0]?.accountId).toBe(22);
    expect(results[0]?.result?.success).toBe(false);
    expect(results[0]?.result?.status).toBe('failed');
    expect(results[1]?.accountId).toBe(23);
    expect(results[1]?.result?.success).toBe(true);
  });
});
