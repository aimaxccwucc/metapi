import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshSub2ApiManagedSessionMock = vi.fn();

vi.mock('./sub2apiManagedAuth.js', () => ({
  refreshSub2ApiManagedSession: (...args: unknown[]) => refreshSub2ApiManagedSessionMock(...args),
}));

describe('sub2apiRefreshSingleflight', () => {
  beforeEach(async () => {
    refreshSub2ApiManagedSessionMock.mockReset();
    const module = await import('./sub2apiRefreshSingleflight.js');
    module.__resetSub2ApiManagedRefreshSingleflightForTests();
  });

  it('reuses the same in-flight refresh promise for the same account', async () => {
    let resolveRefresh: ((value: { accessToken: string; extraConfig: string }) => void) | null = null;
    refreshSub2ApiManagedSessionMock.mockImplementation(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    const module = await import('./sub2apiRefreshSingleflight.js');
    const params = {
      account: { id: 101, extraConfig: null, accessToken: 'old-token', status: 'active' },
      site: { id: 201, url: 'https://sub2.example.com', platform: 'sub2api', status: 'active' },
      currentAccessToken: 'old-token',
      currentExtraConfig: null,
    };

    const first = module.refreshSub2ApiManagedSessionSingleflight(params as any);
    const second = module.refreshSub2ApiManagedSessionSingleflight(params as any);

    expect(refreshSub2ApiManagedSessionMock).toHaveBeenCalledTimes(1);

    resolveRefresh?.({
      accessToken: 'new-token',
      extraConfig: '{"sub2apiAuth":{"refreshToken":"refresh-2"}}',
    });

    await expect(first).resolves.toMatchObject({
      accessToken: 'new-token',
    });
    await expect(second).resolves.toMatchObject({
      accessToken: 'new-token',
    });
  });
});
