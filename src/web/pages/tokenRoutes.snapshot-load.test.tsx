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
  },
  getBrandMock: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => false,
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

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TokenRoutes cached snapshot load', () => {
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
        unavailableModels: 0,
        siteProfiles: 0,
        checkinTodoSites: 0,
      },
      endpointRuntimeMemory: { total: 0, items: [] },
      endpointCredentialScopes: { total: 0, items: [] },
      persistedEndpointProfiles: { total: 0, items: [] },
      modelCircuits: { total: 0, openCount: 0, halfOpenCount: 0, items: [] },
      siteRuntimeHealth: { total: 0, breakerOpenCount: 0, penalizedCount: 0, items: [] },
      unavailableModels: { total: 0, blockingCount: 0, items: [] },
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
        sites: [],
      },
    });
    apiMock.getRoutesSummary.mockResolvedValue([
      {
        id: 1,
        modelPattern: 'gpt-4o-mini',
        displayName: 'gpt-4o-mini',
        displayIcon: null,
        routeMode: 'explicit_group',
        sourceRouteIds: [101],
        modelMapping: null,
        enabled: true,
        channelCount: 1,
        enabledChannelCount: 1,
        siteNames: ['cached-site'],
        decisionSnapshot: {
          requestedModel: 'gpt-4o-mini',
          actualModel: 'gpt-4o-mini',
          matched: true,
          selectedChannelId: 11,
          selectedLabel: 'cached-user @ cached-site / cached-token',
          summary: ['命中路由：gpt-4o-mini'],
          candidates: [
            {
              channelId: 11,
              accountId: 101,
              username: 'cached-user',
              siteName: 'cached-site',
              tokenName: 'cached-token',
              priority: 0,
              weight: 10,
              eligible: true,
              recentlyFailed: false,
              avoidedByRecentFailure: false,
              probability: 88.8,
              reason: '缓存命中',
            },
          ],
        },
        decisionRefreshedAt: '2026-03-08T01:23:45.000Z',
      },
    ]);
    apiMock.getRouteChannels.mockResolvedValue([
      {
        id: 11,
        accountId: 101,
        tokenId: 1001,
        sourceModel: 'gpt-4o-mini',
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
        successCount: 0,
        failCount: 0,
        account: { username: 'cached-user' },
        site: { name: 'cached-site' },
        token: { id: 1001, name: 'cached-token', accountId: 101, enabled: true, isDefault: true },
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    globalThis.IntersectionObserver = originalIntersectionObserver;
  });

  it('shows cached probabilities immediately from getRoutes snapshot data', async () => {
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

      // Expand the route card to see channel details with probability
      const expandBtn = root.root.find((node) =>
        node.type === 'div' && String(node.props.className || '').includes('route-card-collapsed'),
      );
      await act(async () => {
        expandBtn.props.onClick();
      });
      await flushMicrotasks();

      const expandSourceGroupBtn = root.root.find((node) => (
        node.type === 'button'
        && node.props['aria-expanded'] === false
        && collectText(node).includes('gpt-4o-mini')
      ));
      await act(async () => {
        expandSourceGroupBtn.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('88.8%');
      expect(text).toContain('cached-user');
    } finally {
      root?.unmount();
    }
  });
});
