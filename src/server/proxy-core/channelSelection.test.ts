import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectChannelMock = vi.fn();
const selectPreferredChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const getStickyChannelIdMock = vi.fn();
const clearStickyChannelMock = vi.fn();

vi.mock('../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectPreferredChannel: (...args: unknown[]) => selectPreferredChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
  },
}));

vi.mock('../services/routeRefreshWorkflow.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../services/proxyChannelCoordinator.js', () => ({
  proxyChannelCoordinator: {
    getStickyChannelId: (...args: unknown[]) => getStickyChannelIdMock(...args),
    clearStickyChannel: (...args: unknown[]) => clearStickyChannelMock(...args),
  },
}));

describe('selectProxyChannelForAttempt', () => {
  beforeEach(() => {
    selectChannelMock.mockReset();
    selectPreferredChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    getStickyChannelIdMock.mockReset();
    clearStickyChannelMock.mockReset();
  });

  it('uses preferred channel selection for forced channel on first attempt', async () => {
    const selected = { channel: { id: 11 } };
    selectPreferredChannelMock.mockResolvedValueOnce(selected);

    const { selectProxyChannelForAttempt } = await import('./channelSelection.js');
    const result = await selectProxyChannelForAttempt({
      requestedModel: 'gpt-5.4',
      downstreamPolicy: {} as any,
      excludeChannelIds: [],
      retryCount: 0,
      forcedChannelId: 11,
    });

    expect(result).toBe(selected);
    expect(selectPreferredChannelMock).toHaveBeenCalledWith('gpt-5.4', 11, {});
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).not.toHaveBeenCalled();
  });

  it('uses sticky preferred channel before generic selection', async () => {
    const selected = { channel: { id: 21 } };
    getStickyChannelIdMock.mockReturnValueOnce(21);
    selectPreferredChannelMock.mockResolvedValueOnce(selected);

    const { selectProxyChannelForAttempt } = await import('./channelSelection.js');
    const result = await selectProxyChannelForAttempt({
      requestedModel: 'claude-sonnet-4-6',
      downstreamPolicy: { any: 'policy' } as any,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: 'sticky-key',
    });

    expect(result).toBe(selected);
    expect(getStickyChannelIdMock).toHaveBeenCalledWith('sticky-key');
    expect(selectPreferredChannelMock).toHaveBeenCalledWith('claude-sonnet-4-6', 21, { any: 'policy' });
    expect(selectChannelMock).not.toHaveBeenCalled();
  });

  it('refreshes routes and clears stale sticky binding when preferred channel stays unavailable', async () => {
    getStickyChannelIdMock.mockReturnValueOnce(31);
    selectPreferredChannelMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const fallbackSelected = { channel: { id: 41 } };
    selectChannelMock.mockResolvedValueOnce(fallbackSelected);
    refreshModelsAndRebuildRoutesMock.mockResolvedValueOnce(undefined);

    const { selectProxyChannelForAttempt } = await import('./channelSelection.js');
    const result = await selectProxyChannelForAttempt({
      requestedModel: 'gpt-5.4',
      downstreamPolicy: { foo: 'bar' } as any,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: 'stale-sticky',
    });

    expect(result).toBe(fallbackSelected);
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(2);
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(1);
    expect(clearStickyChannelMock).toHaveBeenCalledWith('stale-sticky', 31);
    expect(selectChannelMock).toHaveBeenCalledWith('gpt-5.4', { foo: 'bar' });
  });
});
