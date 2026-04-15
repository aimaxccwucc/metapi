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

describe('Dashboard site observability panel', () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getRuntimeOverview.mockResolvedValue({
      service: {
        name: 'metapi',
        version: '1.2.3',
        uptimeSec: 7_560,
        startedAt: '2026-03-24T21:54:00.000Z',
        now: '2026-03-25T00:00:00.000Z',
        environment: {
          port: 3000,
          host: '0.0.0.0',
          dbDialect: 'sqlite',
          dataDir: '/tmp/metapi',
        },
      },
      database: { ready: false, dialect: 'sqlite' },
      oauthLoopback: { total: 3, ready: 1, attempted: 2, states: [] },
      backgroundTasks: { total: 4, pending: 1, running: 2, failed: 1 },
      notifications: {
        webhookEnabled: false,
        barkEnabled: false,
        telegramEnabled: true,
        serverChanEnabled: false,
        smtpEnabled: false,
        cooldownSec: 60,
      },
      recentActivity: { proxyRequests24h: 20, proxyFailures24h: 6, unreadEvents: 5 },
    });
    apiMock.getDashboard.mockResolvedValue({
      totalBalance: 0,
      totalUsed: 0,
      todaySpend: 0,
      todayReward: 0,
      activeAccounts: 0,
      totalAccounts: 0,
      todayCheckin: { success: 0, total: 0 },
      proxy24h: { success: 0, total: 0, totalTokens: 0 },
      performance: { windowSeconds: 60, requestsPerMinute: 0, tokensPerMinute: 0 },
      siteAvailability: [{
        siteId: 1,
        siteName: 'Demo Site',
        siteUrl: 'https://example.com',
        platform: 'new-api',
        totalRequests: 8,
        successCount: 6,
        failedCount: 2,
        availabilityPercent: 75,
        averageLatencyMs: 320,
        buckets: Array.from({ length: 24 }, (_, index) => ({
          startUtc: new Date(Date.UTC(2026, 2, 11, index, 0, 0)).toISOString(),
          label: `2026-03-11 ${String(index).padStart(2, '0')}:00:00`,
          totalRequests: index < 8 ? 1 : 0,
          successCount: index < 6 ? 1 : 0,
          failedCount: index >= 6 && index < 8 ? 1 : 0,
          availabilityPercent: index < 6 ? 100 : index < 8 ? 0 : null,
          averageLatencyMs: index < 8 ? 320 : null,
        })),
      }],
      modelAnalysis: null,
    });
    apiMock.getSiteDistribution.mockResolvedValue({ distribution: [] });
    apiMock.getSiteTrend.mockResolvedValue({ trend: [] });
    apiMock.getSites.mockResolvedValue([]);
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getElementById: vi.fn(() => null),
    } as unknown as Document;
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    vi.clearAllMocks();
  });

  it('renders site availability strips and summary metrics', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/']}>
            <ToastProvider>
              <Dashboard />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const panel = root!.root.find((node) => (
        typeof node.props.className === 'string'
        && node.props.className.includes('site-observability-panel')
      ));

      const cells = panel.findAll((node) => (
        node.type === 'a'
        && typeof node.props.className === 'string'
        && node.props.className.includes('site-availability-cell')
      ));

      const logLink = panel.find((node) => (
        node.type === 'a'
        && typeof node.props.className === 'string'
        && node.props.className.includes('site-observability-log-link')
      ));

      expect(collectText(panel)).toContain('站点可用性观测');
      expect(collectText(panel)).toContain('Demo Site');
      expect(collectText(panel)).toContain('75%');
      expect(collectText(panel)).toContain('320ms');
      expect(logLink.props.title).toBe('查看日志');
      expect(cells).toHaveLength(24);
      expect(String(cells[0]?.props.title || '')).toContain('可用性 100%');
      expect(String(cells[7]?.props.title || '')).toContain('可用性 0%');
      expect(String(cells[0]?.props['data-tooltip'] || '')).toContain('时间：');
      expect(String(cells[0]?.props['data-tooltip'] || '')).toContain('可用性：100%');
      expect(String(cells[0]?.props['data-tooltip'] || '')).toContain('成功/失败：1/0');
      expect(String(logLink.props.href || logLink.props.to || '')).toContain('/logs?siteId=1');
      expect(collectText(root!.root)).toContain('运行时概览');
      expect(collectText(root!.root)).toContain('数据库未就绪，配置与统计可能异常。');
      expect(collectText(root!.root)).toContain('失败 1 · 统一在任务中心查看');
      expect(collectText(root!.root)).toContain('存在 5 条未读状态事件。');
      expect(collectText(root!.root)).toContain('状态事件');
      expect(collectText(root!.root)).toContain('路由策略');
      expect(collectText(root!.root)).toContain('系统设置');
    } finally {
      root?.unmount();
    }
  });
});
