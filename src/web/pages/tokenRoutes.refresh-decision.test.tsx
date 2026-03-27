import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import TokenRoutes from './TokenRoutes.js';

const { apiMock, getBrandMock } = vi.hoisted(() => ({
  apiMock: {
    getRoutesSummary: vi.fn(),
    getRouteChannels: vi.fn(),
    getModelTokenCandidates: vi.fn(),
    getRouteDecisionsBatch: vi.fn(),
    getRouteWideDecisionsBatch: vi.fn(),
    getRouteDiagnostics: vi.fn(),
    resetRoutingRuntimeState: vi.fn(),
  },
  getBrandMock: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: ({ brand, icon, model }: { brand?: { name?: string } | null; icon?: string | null; model?: string | null }) => (
    <span>{brand?.name || icon || model || ''}</span>
  ),
  InlineBrandIcon: ({ model }: { model: string }) => model ? <span>{model}</span> : null,
  getBrand: (...args: unknown[]) => getBrandMock(...args),
  hashColor: () => 'linear-gradient(135deg,#4f46e5,#818cf8)',
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function findButtonByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).includes(text)
  ));
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TokenRoutes refresh decision action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBrandMock.mockReset();
    getBrandMock.mockReturnValue(null);
    apiMock.getRoutesSummary.mockResolvedValue([
      {
        id: 1, modelPattern: 'gpt-4o-mini', displayName: 'gpt-4o-mini',
        displayIcon: null, modelMapping: null, enabled: true,
        channelCount: 0, enabledChannelCount: 0, siteNames: [],
        decisionSnapshot: null, decisionRefreshedAt: null,
      },
      {
        id: 2, modelPattern: 're:^claude-(opus|sonnet)-4-6$', displayName: 'claude-group',
        displayIcon: null, modelMapping: null, enabled: true,
        channelCount: 0, enabledChannelCount: 0, siteNames: [],
        decisionSnapshot: null, decisionRefreshedAt: null,
      },
    ]);
    apiMock.getRouteChannels.mockResolvedValue([]);
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getRouteDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRouteWideDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRouteDiagnostics.mockResolvedValue({
      success: true,
      generatedAt: '2026-03-26T00:00:00.000Z',
      limits: { itemLimit: 120 },
      routeSummary: { routeCount: 0, enabledRouteCount: 0, channelCount: 0, enabledChannelCount: 0 },
      snapshotCounts: {
        endpointRuntimeMemory: 0,
        endpointCredentialScopes: 0,
        persistedEndpointProfiles: 0,
        modelCircuits: 0,
        siteRuntimeStates: 0,
        accountRuntimeStates: 0,
        unavailableModels: 0,
        siteProfiles: 0,
        checkinTodoSites: 0,
        checkinSiteRuntimeStates: 0,
      },
      endpointRuntimeMemory: { total: 0, items: [] },
      endpointCredentialScopes: { total: 0, items: [] },
      persistedEndpointProfiles: { total: 0, items: [] },
      modelCircuits: { total: 0, openCount: 0, halfOpenCount: 0, items: [] },
      siteRuntimeHealth: { total: 0, breakerOpenCount: 0, penalizedCount: 0, items: [] },
      accountRuntimeHealth: { total: 0, busyCount: 0, stickyActiveCount: 0, items: [] },
      unavailableModels: { total: 0, blockingCount: 0, items: [] },
      checkinSiteRuntime: { total: 0, blockedCount: 0, items: [] },
      siteProfiles: { total: 0, manualConfiguredCount: 0, items: [] },
      checkinTodo: {
        scheduleMode: 'interval',
        intervalHours: 6,
        totalSchedulableAccounts: 0,
        dueNowCount: 0,
        manualRequiredCount: 0,
        unsupportedCount: 0,
        failedRecentCount: 0,
        attentionCount: 0,
        siteBackoffBlockedCount: 0,
        sites: [],
      },
    });
    apiMock.resetRoutingRuntimeState.mockResolvedValue({
      success: true,
      updatedChannels: 2,
      clearedModelCircuits: 1,
      clearedPersistedSiteRuntimeState: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {
        confirm: vi.fn(() => true),
        location: { reload: vi.fn() },
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes refreshPricingCatalog and persistSnapshots when user clicks refresh route decisions', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const refreshButton = findButtonByText(root.root, '刷新路由决策');
      await act(async () => {
        await refreshButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getRouteDecisionsBatch).toHaveBeenCalledWith(['gpt-4o-mini'], { refreshPricingCatalog: true, persistSnapshots: true });
      expect(apiMock.getRouteWideDecisionsBatch).toHaveBeenCalledWith([2], { refreshPricingCatalog: true, persistSnapshots: true });
    } finally {
      root?.unmount();
    }
  });

  it('resets routing runtime state and reloads decisions when user clicks runtime recovery', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const resetButton = findButtonByText(root.root, '清理运行时故障');
      await act(async () => {
        await resetButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.resetRoutingRuntimeState).toHaveBeenCalledTimes(1);
      expect(apiMock.getRoutesSummary).toHaveBeenCalledTimes(2);
      expect(apiMock.getRouteDecisionsBatch).toHaveBeenLastCalledWith(['gpt-4o-mini'], { refreshPricingCatalog: true, persistSnapshots: true });
      expect(apiMock.getRouteWideDecisionsBatch).toHaveBeenLastCalledWith([2], { refreshPricingCatalog: true, persistSnapshots: true });
    } finally {
      root?.unmount();
    }
  });

  it('renders route fault overview badges after decision snapshot is available', async () => {
    apiMock.getRoutesSummary.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'claude-sonnet-4-6',
        displayName: 'claude-sonnet-4-6',
        displayIcon: null,
        modelMapping: null,
        enabled: true,
        channelCount: 0,
        enabledChannelCount: 0,
        siteNames: ['Demo Site'],
        decisionSnapshot: null,
        decisionRefreshedAt: null,
      },
      {
        id: 2,
        modelPattern: 'claude-opus-4-6',
        displayName: 'claude-opus-4-6',
        displayIcon: null,
        modelMapping: null,
        enabled: true,
        channelCount: 1,
        enabledChannelCount: 1,
        siteNames: ['Demo Site'],
        decisionSnapshot: null,
        decisionRefreshedAt: null,
      },
      {
        id: 9,
        routeMode: 'explicit_group',
        modelPattern: 'claude-group',
        displayName: 'claude-group',
        displayIcon: null,
        modelMapping: null,
        enabled: true,
        channelCount: 2,
        enabledChannelCount: 2,
        siteNames: ['Demo Site'],
        decisionSnapshot: {
          requestedModel: 'claude-group',
          actualModel: 'claude-group',
          matched: true,
          summary: ['最近失败导致部分通道被临时避让'],
          candidates: [
            {
              channelId: 101,
              accountId: 1,
              username: 'demo-a',
              siteName: 'Demo Site',
              tokenName: 'token-a',
              priority: 0,
              weight: 1,
              eligible: false,
              recentlyFailed: true,
              avoidedByRecentFailure: true,
              cooldownUntil: '2099-01-01T00:00:00.000Z',
              probability: 0,
              reason: 'cooldown',
              modelCircuitStatus: { isOpen: true, state: 'open', reason: 'recent failures' },
              siteRuntimeState: { combinedMultiplier: 0.4, modelBreakerOpen: false, globalBreakerOpen: false },
            },
            {
              channelId: 102,
              accountId: 2,
              username: 'demo-b',
              siteName: 'Demo Site',
              tokenName: 'token-b',
              priority: 1,
              weight: 1,
              eligible: true,
              recentlyFailed: false,
              avoidedByRecentFailure: false,
              probability: 1,
              reason: 'ok',
            },
          ],
        },
        decisionRefreshedAt: '2026-03-25T00:00:00.000Z',
        sourceRouteIds: [1, 2],
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {},
      modelsWithoutToken: {
        'claude-sonnet-4-6': [{ siteId: 1, siteName: 'Demo Site', accountId: 1, username: 'demo-a' }],
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const pageText = collectText(root.root);
      expect(pageText).toContain('当前故障总览');
      expect(pageText).toContain('冷却中 1');
      expect(pageText).toContain('失败避让 1');
      expect(pageText).toContain('模型熔断 1');
      expect(pageText).toContain('站点惩罚 1');
      expect(pageText).toContain('来源异常群组 1');
    } finally {
      root?.unmount();
    }
  });
});
