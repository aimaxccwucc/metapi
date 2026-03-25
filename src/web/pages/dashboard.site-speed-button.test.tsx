import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Dashboard from './Dashboard.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getDashboard: vi.fn(),
    getRuntimeOverview: vi.fn(),
    getSiteDistribution: vi.fn(),
    getSiteTrend: vi.fn(),
    getSites: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
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

describe('Dashboard site speed buttons', () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getDashboard.mockResolvedValue({
      totalBalance: 0,
      totalUsed: 0,
      todaySpend: 0,
      todayReward: 0,
      activeAccounts: 0,
      totalAccounts: 0,
      todayCheckin: { success: 0, total: 0 },
      proxy24h: { success: 0, total: 0, totalTokens: 0 },
      modelAnalysis: null,
    });
    apiMock.getRuntimeOverview.mockResolvedValue({
      service: {
        name: 'metapi',
        version: '1.2.3',
        uptimeSec: 120,
        startedAt: '2026-03-25T00:00:00.000Z',
        now: '2026-03-25T00:02:00.000Z',
        environment: {
          port: 3000,
          host: '0.0.0.0',
          dbDialect: 'sqlite',
          dataDir: '/tmp/metapi',
        },
      },
      database: { ready: true, dialect: 'sqlite' },
      oauthLoopback: { total: 1, ready: 1, attempted: 1, states: [] },
      backgroundTasks: { total: 0, pending: 0, running: 0, failed: 0 },
      notifications: {
        webhookEnabled: false,
        barkEnabled: false,
        telegramEnabled: false,
        serverChanEnabled: false,
        smtpEnabled: false,
        cooldownSec: 0,
      },
      recentActivity: { proxyRequests24h: 0, proxyFailures24h: 0, unreadEvents: 0 },
    });
    apiMock.getSiteDistribution.mockResolvedValue({ distribution: [] });
    apiMock.getSiteTrend.mockResolvedValue({ trend: [] });
    apiMock.getSites.mockResolvedValue([
      { id: 1, name: 'Demo Site', url: 'https://example.com', status: 'active' },
    ]);

    globalThis.document = {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getElementById: vi.fn(() => null),
    } as unknown as Document;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.clearAllMocks();
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  });

  it('updates site speed status without imperative document lookups', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Dashboard />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const speedButton = root!.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '测速'
      ));

      await act(async () => {
        await speedButton.props.onClick();
      });
      await flushMicrotasks();

      expect(globalThis.document.getElementById).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });

  it('updates bulk site speed status without imperative document lookups', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Dashboard />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const bulkSpeedButton = root!.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '一键测速'
      ));

      await act(async () => {
        await bulkSpeedButton.props.onClick();
      });
      await flushMicrotasks();

      expect(globalThis.document.getElementById).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});
