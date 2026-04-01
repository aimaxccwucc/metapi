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
    getRouteOverview: vi.fn(),
    getRouteGovernanceSubjects: vi.fn(),
    runRouteGovernanceRecoveryPass: vi.fn(),
    updateRoute: vi.fn(),
    rebuildRoutes: vi.fn(),
    deleteRoute: vi.fn(),
    deleteChannel: vi.fn(),
  },
  getBrandMock: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (node: unknown) => node,
  };
});

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
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
  const matches = root.findAll((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).includes(text)
  ));
  if (matches.length === 0) {
    throw new Error(`button not found: ${text}`);
  }
  return matches[0];
}

async function waitForText(root: ReactTestInstance, text: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (collectText(root).includes(text)) return;
    await flushMicrotasks();
  }
}

async function switchToAllRoutes(root: ReactTestInstance) {
  const openFiltersButton = findButtonByText(root, '筛选');
  await act(async () => {
    openFiltersButton.props.onClick();
  });
  await flushMicrotasks();

  const showAllRoutesButton = findButtonByText(root, '显示全部路由');
  await act(async () => {
    showAllRoutesButton.props.onClick();
  });
  await flushMicrotasks();
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TokenRoutes mobile layout', () => {
  const originalIntersectionObserver = globalThis.IntersectionObserver;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.IntersectionObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [];
    } as unknown as typeof IntersectionObserver;
    getBrandMock.mockReset();
    getBrandMock.mockReturnValue(null);
    apiMock.getRoutesSummary.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'gpt-4o-mini',
        displayName: 'gpt-4o-mini',
        displayIcon: null,
        modelMapping: null,
        routingStrategy: 'weighted',
        enabled: true,
        channelCount: 1,
        enabledChannelCount: 1,
        siteNames: ['site-a'],
        decisionSnapshot: null,
        decisionRefreshedAt: null,
      },
    ]);
    apiMock.getRouteChannels.mockResolvedValue([
      {
        id: 11,
        accountId: 101,
        tokenId: 1001,
        sourceModel: 'gpt-4o-mini',
        priority: 0,
        weight: 1,
        enabled: true,
        manualOverride: false,
        successCount: 0,
        failCount: 0,
        account: { username: 'user_a' },
        site: { name: 'site-a' },
        token: { id: 1001, name: 'token-a', accountId: 101, enabled: true, isDefault: true },
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({
      models: {
        'gpt-4o-mini': [
          {
            accountId: 101,
            tokenId: 1001,
            tokenName: 'token-a',
            isDefault: true,
            username: 'user_a',
            siteId: 1,
            siteName: 'site-a',
          },
        ],
      },
    });
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
    apiMock.getRouteOverview.mockResolvedValue({
      success: true,
      generatedAt: '2026-04-01T00:00:00.000Z',
      routeSummary: { routeCount: 0, enabledRouteCount: 0, channelCount: 0, enabledChannelCount: 0 },
      governance: { total: 0, suppressed: 0, probing: 0, byReason: {} },
      runtime: {
        modelCircuitOpen: 0,
        modelCircuitHalfOpen: 0,
        siteRuntimeBreakerOpen: 0,
        siteRuntimePenalized: 0,
        unavailableModelBlocking: 0,
        checkinAttention: 0,
        checkinSiteBackoffBlocked: 0,
      },
    });
    apiMock.getRouteGovernanceSubjects.mockResolvedValue({
      success: true,
      total: 0,
      summary: {
        total: 0,
        suppressedCount: 0,
        probingCount: 0,
        countsByReason: {},
        countsBySubjectType: {},
      },
      items: [],
    });
    apiMock.runRouteGovernanceRecoveryPass.mockResolvedValue({
      success: true,
      scanned: 0,
      promotedToProbing: 0,
      keptSuppressed: 0,
      restored: 0,
      items: [],
    });
    apiMock.updateRoute.mockResolvedValue({});
    apiMock.rebuildRoutes.mockResolvedValue({ rebuild: { createdRoutes: 0, createdChannels: 0 } });
    apiMock.deleteRoute.mockResolvedValue({});
    apiMock.deleteChannel.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    globalThis.IntersectionObserver = originalIntersectionObserver;
  });

  it('shows direct mobile actions and reveals the management panel after expansion', async () => {
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
      await waitForText(root!.root, 'gpt-4o-mini');
      await switchToAllRoutes(root!.root);

      const summaryText = collectText(root!.root);
      expect(summaryText).toContain('详情');
      expect(summaryText).toContain('禁用');
      expect(summaryText).toContain('添加通道');

      const expandButton = findButtonByText(root!.root, '详情');

      await act(async () => {
        await expandButton.props.onClick();
      });
      await flushMicrotasks();

      const expandedText = collectText(root!.root);
      expect(expandedText).toContain('路由策略');
      expect(expandedText).toContain('权重随机');
      expect(expandedText).toContain('user_a');
      expect(expandedText).toContain('token-a');
    } finally {
      root?.unmount();
    }
  });

  it('lets mobile users toggle route enabled state from the summary card', async () => {
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
      await waitForText(root!.root, 'gpt-4o-mini');
      await switchToAllRoutes(root!.root);

      const toggleButton = findButtonByText(root!.root, '禁用');

      await act(async () => {
        await toggleButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRoute).toHaveBeenCalledWith(1, { enabled: false });
      expect(findButtonByText(root!.root, '启用')).toBeTruthy();
    } finally {
      root?.unmount();
    }
  });
});
