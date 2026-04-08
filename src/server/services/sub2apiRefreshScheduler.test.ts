import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectAllMock = vi.fn();
const refreshSub2ApiManagedSessionSingleflightMock = vi.fn();

vi.mock('../db/index.js', () => {
  const queryChain = {
    all: () => selectAllMock(),
    where: () => queryChain,
    innerJoin: () => queryChain,
    from: () => queryChain,
  };

  return {
    db: {
      select: () => queryChain,
    },
    schema: {
      accounts: { siteId: 'siteId', status: 'status' },
      sites: { id: 'id', status: 'status', platform: 'platform' },
    },
  };
});

vi.mock('./sub2apiRefreshSingleflight.js', () => ({
  refreshSub2ApiManagedSessionSingleflight: (...args: unknown[]) => refreshSub2ApiManagedSessionSingleflightMock(...args),
}));

describe('sub2apiRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    selectAllMock.mockReset();
    refreshSub2ApiManagedSessionSingleflightMock.mockReset();
  });

  afterEach(async () => {
    const module = await import('./sub2apiRefreshScheduler.js');
    await module.__resetSub2ApiManagedRefreshSchedulerForTests();
    vi.useRealTimers();
  });

  it('refreshes only due active sub2api accounts', async () => {
    const nowMs = new Date('2026-04-08T12:00:00.000Z').getTime();
    selectAllMock.mockResolvedValue([
      {
        accounts: {
          id: 1,
          accessToken: 'token-a',
          extraConfig: JSON.stringify({
            sub2apiAuth: {
              refreshToken: 'refresh-a',
              tokenExpiresAt: nowMs + 60_000,
            },
          }),
          status: 'active',
        },
        sites: {
          id: 11,
          url: 'https://sub2-a.example.com',
          platform: 'sub2api',
          status: 'active',
        },
      },
      {
        accounts: {
          id: 2,
          accessToken: 'token-b',
          extraConfig: JSON.stringify({
            sub2apiAuth: {
              refreshToken: 'refresh-b',
              tokenExpiresAt: nowMs + 10 * 60_000,
            },
          }),
          status: 'active',
        },
        sites: {
          id: 12,
          url: 'https://sub2-b.example.com',
          platform: 'sub2api',
          status: 'active',
        },
      },
      {
        accounts: {
          id: 3,
          accessToken: 'token-c',
          extraConfig: JSON.stringify({
            sub2apiAuth: {
              refreshToken: 'refresh-c',
              tokenExpiresAt: nowMs + 60_000,
            },
          }),
          status: 'disabled',
        },
        sites: {
          id: 13,
          url: 'https://sub2-c.example.com',
          platform: 'sub2api',
          status: 'active',
        },
      },
    ]);
    refreshSub2ApiManagedSessionSingleflightMock.mockResolvedValue({
      accessToken: 'new-token-a',
      extraConfig: '{"sub2apiAuth":{"refreshToken":"refresh-a2"}}',
    });

    const module = await import('./sub2apiRefreshScheduler.js');
    const result = await module.executeSub2ApiManagedRefreshPass({ nowMs });

    expect(refreshSub2ApiManagedSessionSingleflightMock).toHaveBeenCalledTimes(1);
    expect(refreshSub2ApiManagedSessionSingleflightMock).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({ id: 1 }),
      site: expect.objectContaining({ id: 11 }),
    }));
    expect(result).toMatchObject({
      scanned: 3,
      refreshed: 1,
      failed: 0,
      skipped: 2,
      refreshedAccountIds: [1],
    });
  });

  it('runs one immediate pass and continues on interval without overlapping', async () => {
    selectAllMock.mockResolvedValue([]);
    refreshSub2ApiManagedSessionSingleflightMock.mockResolvedValue({
      accessToken: 'unused',
      extraConfig: '{}',
    });

    const module = await import('./sub2apiRefreshScheduler.js');
    module.startSub2ApiManagedRefreshScheduler(60_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(selectAllMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(selectAllMock).toHaveBeenCalledTimes(2);
  });
});
