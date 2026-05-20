import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import ModernSelect from '../components/ModernSelect.js';
import { ToastProvider } from '../components/Toast.js';
import ProxyLogs from './ProxyLogs.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getProxyLogs: vi.fn(),
    getProxyLogDetail: vi.fn(),
    getProxyDebugTraces: vi.fn(),
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
    await Promise.resolve();
  });
}

function buildListResponse(overrides?: Partial<{
  items: any[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    totalCount: number;
    successCount: number;
    failedCount: number;
    totalCost: number;
    totalTokensAll: number;
  };
}>) {
  return {
    items: [
      {
        id: 101,
        createdAt: '2026-03-09 16:00:00',
        modelRequested: 'gpt-4o',
        modelActual: 'gpt-4o',
        status: 'success',
        latencyMs: 120,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        retryCount: 0,
        estimatedCost: 1.23,
        errorMessage: 'downstream: /v1/chat upstream: /api/chat',
        username: 'tester',
        accountBalance: 12.34,
        accountBalanceEstimated: 11.11,
        siteName: 'main-site',
        siteUrl: 'https://main-site.example.com',
        clientFamily: 'codex',
        clientAppId: 'cherry_studio',
        clientAppName: 'Cherry Studio',
        clientConfidence: 'heuristic',
        downstreamKeyName: '移动端灰度',
        downstreamKeyGroupName: '项目A',
        downstreamKeyTags: ['VIP', '灰度'],
      },
    ],
    total: 1,
    page: 1,
    pageSize: 50,
    summary: {
      totalCount: 12,
      successCount: 8,
      failedCount: 4,
      totalCost: 1.23,
      totalTokensAll: 15,
    },
    clientOptions: [
      { value: 'app:cherry_studio', label: '应用 · Cherry Studio' },
      { value: 'family:codex', label: '协议 · Codex' },
    ],
    ...overrides,
  };
}

describe('ProxyLogs server-driven page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      { id: 9, name: 'main-site', status: 'active' },
      { id: 12, name: 'backup-site', status: 'active' },
    ]);
    apiMock.getProxyLogs.mockResolvedValue(buildListResponse());
    apiMock.getProxyDebugTraces.mockResolvedValue({
      success: true,
      total: 1,
      summary: {
        total: 3,
        kinds: {
          proxy_exception: 1,
        },
        sites: [{ siteId: 9, siteName: 'main-site', count: 1 }],
      },
      items: [
        {
          at: '2026-03-09T08:00:00.000Z',
          kind: 'proxy_exception',
          traceId: 'session:turn-1',
          sessionId: 'turn-1',
          traceHint: 'turn-1',
          requestedModel: 'gpt-4o',
          actualModel: 'gpt-4o',
          siteId: 9,
          siteName: 'main-site',
          status: 502,
          retryCount: 1,
          reason: 'upstream timeout',
          detail: { phase: 'proxy', upstreamStatus: 502 },
        },
      ],
    });
    apiMock.getProxyLogDetail.mockResolvedValue({
      id: 101,
      createdAt: '2026-03-09 16:00:00',
      modelRequested: 'gpt-4o',
      modelActual: 'gpt-4o',
      status: 'success',
      latencyMs: 120,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      retryCount: 0,
      estimatedCost: 1.23,
      errorMessage: 'downstream: /v1/chat upstream: /api/chat',
      username: 'tester',
      accountBalance: 12.34,
      accountBalanceEstimated: 11.11,
      siteName: 'main-site',
      siteUrl: 'https://main-site.example.com',
      routeId: 25009,
      entryRouteId: 25011,
      sourceRouteId: 25009,
      channelId: 127191,
      clientFamily: 'codex',
      clientAppId: 'cherry_studio',
      clientAppName: 'Cherry Studio',
      clientConfidence: 'heuristic',
      downstreamKeyName: '移动端灰度',
      downstreamKeyGroupName: '项目A',
      downstreamKeyTags: ['VIP', '灰度'],
      billingDetails: {
        breakdown: {
          inputPerMillion: 1,
          outputPerMillion: 2,
          cacheReadPerMillion: 0,
          cacheCreationPerMillion: 0,
          inputCost: 0.1,
          outputCost: 0.2,
          cacheReadCost: 0,
          cacheCreationCost: 0,
          totalCost: 0.3,
        },
        pricing: {
          modelRatio: 1,
          completionRatio: 1,
          cacheRatio: 0,
          cacheCreationRatio: 0,
          groupRatio: 1,
        },
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          billablePromptTokens: 10,
          promptTokensIncludeCache: false,
        },
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests paginated data from the server and renders server summary counts', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(apiMock.getProxyLogs).toHaveBeenCalledWith({
        limit: 50,
        offset: 0,
        status: 'all',
        search: '',
      });

      const text = collectText(root!.root);
      expect(text).toContain('消耗总额 $1.2300');
      expect(text).toContain('全部 12');
      expect(text).toContain('成功 8');
      expect(text).toContain('失败 4');
      expect(text).toContain('Cherry Studio');
      expect(text).toContain('Codex');
      expect(text).toContain('推测');
      expect(text).toContain('余额');
      expect(text).toContain('$11.11');
      expect(text).toContain('下游 Key: 移动端灰度');
    } finally {
      root?.unmount();
    }
  });

  it('keeps the model badge sized to the model name in desktop rows', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const modelBadge = root!.root.find((node) => (
        node.type === 'span'
        && collectText(node) === 'gpt-4o'
        && node.props.style?.display === 'inline-flex'
      ));

      expect(modelBadge.props.style?.alignSelf).toBe('flex-start');
    } finally {
      root?.unmount();
    }
  });

  it('shows cache source labels when a successful log has no upstream site name', async () => {
    apiMock.getProxyLogs.mockResolvedValue(buildListResponse({
      items: [
        {
          id: 202,
          createdAt: '2026-03-09 16:05:00',
          modelRequested: 'gpt-4o',
          modelActual: 'gpt-4o',
          status: 'success',
          latencyMs: 0,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          retryCount: 0,
          estimatedCost: 0,
          errorMessage: 'response cache hit',
          username: 'cache',
          siteName: null,
          siteUrl: null,
          cacheStatus: 'hit',
          clientFamily: 'codex',
        },
        {
          id: 203,
          createdAt: '2026-03-09 16:06:00',
          modelRequested: 'gpt-4o',
          modelActual: 'gpt-4o',
          status: 'success',
          latencyMs: 0,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          retryCount: 1,
          estimatedCost: 0,
          errorMessage: 'served stale cache after upstream failure',
          username: 'cache',
          siteName: '',
          siteUrl: null,
          cacheStatus: 'stale',
          clientFamily: 'codex',
        },
      ],
      total: 2,
      summary: {
        totalCount: 2,
        successCount: 2,
        failedCount: 0,
        totalCost: 0,
        totalTokensAll: 30,
      },
    }));

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root!.root);
      expect(text).toContain('缓存命中');
      expect(text).toContain('旧缓存兜底');
      expect(text).not.toContain('>-<');
    } finally {
      root?.unmount();
    }
  });

  it('labels no-channel failures as selection failures instead of unknown upstreams', async () => {
    apiMock.getProxyLogs.mockResolvedValue(buildListResponse({
      items: [
        {
          id: 301,
          createdAt: '2026-03-09 16:10:00',
          modelRequested: 'gpt-5.5',
          modelActual: null,
          status: 'failed',
          latencyMs: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          retryCount: 0,
          estimatedCost: 0,
          errorMessage: '[downstream:/v1/chat/completions] No available channels for this model',
          accountId: null,
          username: null,
          siteId: null,
          siteName: null,
          siteUrl: null,
          clientFamily: 'generic',
        },
      ],
      total: 1,
      summary: {
        totalCount: 1,
        successCount: 0,
        failedCount: 1,
        totalCost: 0,
        totalTokensAll: 0,
      },
    }));
    apiMock.getProxyLogDetail.mockResolvedValue({
      id: 301,
      createdAt: '2026-03-09 16:10:00',
      modelRequested: 'gpt-5.5',
      modelActual: null,
      status: 'failed',
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      retryCount: 0,
      estimatedCost: 0,
      errorMessage: '[downstream:/v1/chat/completions] No available channels for this model',
      accountId: null,
      username: null,
      siteId: null,
      siteName: null,
      siteUrl: null,
      clientFamily: 'generic',
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const row = root!.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-301'
      ));
      expect(collectText(row)).toContain('未选出通道');

      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root!.root);
      expect(text).toContain('站点: 未请求上游');
      expect(text).toContain('账号: 未分配账号');
      expect(text).toContain('上游请求路径未请求上游');
      expect(text).not.toContain('站点: 未知站点');
      expect(text).not.toContain('账号: 未知账号');
    } finally {
      root?.unmount();
    }
  });

  it('renders explicit client self-reports before protocol-family fallback labels', async () => {
    apiMock.getProxyLogs.mockResolvedValue(buildListResponse({
      items: [
        {
          id: 101,
          createdAt: '2026-03-09 16:00:00',
          modelRequested: 'gpt-4o',
          modelActual: 'gpt-4o',
          status: 'success',
          latencyMs: 120,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          retryCount: 0,
          estimatedCost: 1.23,
          errorMessage: 'downstream: /v1/responses upstream: /v1/responses',
          username: 'tester',
          siteName: 'main-site',
          siteUrl: 'https://main-site.example.com',
          clientFamily: 'codex',
          clientAppId: 'openclaw',
          clientAppName: 'openclaw',
          clientConfidence: 'exact',
          downstreamKeyName: '移动端灰度',
          downstreamKeyGroupName: '项目A',
          downstreamKeyTags: ['VIP', '灰度'],
        },
      ],
    }));

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const row = root!.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));
      const rowText = collectText(row);
      expect(rowText).toContain('openclaw');
      expect(rowText).toContain('Codex');
      expect(rowText).not.toContain('推测');
    } finally {
      root?.unmount();
    }
  });

  it('re-queries the server for status, client, and search changes instead of filtering locally', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const failedTab = root!.root.findAll((node) => (
        node.type === 'button' && collectText(node).includes('失败')
      ))[0];
      await act(async () => {
        failedTab.props.onClick();
      });
      await flushMicrotasks();

      const selects = root!.root.findAllByType(ModernSelect);
      const clientSelect = selects.find((node) => node.props.placeholder === '全部客户端');
      expect(clientSelect).toBeDefined();

      await act(async () => {
        clientSelect!.props.onChange('app:cherry_studio');
      });
      await flushMicrotasks();

      const searchInput = root!.root.find((node) => (
        node.type === 'input' && node.props.placeholder === '搜索模型、下游 Key、主分组、标签...'
      ));
      await act(async () => {
        searchInput.props.onChange({ target: { value: 'mini' } });
      });
      await flushMicrotasks();

      expect(apiMock.getProxyLogs).toHaveBeenNthCalledWith(2, {
        limit: 50,
        offset: 0,
        status: 'failed',
        search: '',
      });
      expect(apiMock.getProxyLogs).toHaveBeenNthCalledWith(3, {
        limit: 50,
        offset: 0,
        status: 'failed',
        search: '',
        client: 'app:cherry_studio',
      });
      expect(apiMock.getProxyLogs).toHaveBeenLastCalledWith({
        limit: 50,
        offset: 0,
        status: 'failed',
        search: 'mini',
        client: 'app:cherry_studio',
      });
    } finally {
      root?.unmount();
    }
  });

  it('loads detail on first expand and reuses the cached detail on re-expand', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const row = root!.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));

      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getProxyLogDetail).toHaveBeenCalledTimes(1);

      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getProxyLogDetail).toHaveBeenCalledTimes(1);
      expect(apiMock.getProxyLogDetail).toHaveBeenCalledWith(101);
      expect(collectText(root!.root)).toContain('路由链路：入口 #25011 / 来源 #25009 / 通道 #127191');
    } finally {
      root?.unmount();
    }
  });

  it('hydrates site and time filters from the route query', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs?siteId=9&client=family%3Acodex&from=2026-03-09T08:00&to=2026-03-09T09:00']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const expectedFrom = new Date(2026, 2, 9, 8, 0).toISOString();
      const expectedTo = new Date(2026, 2, 9, 9, 0).toISOString();
      expect(apiMock.getProxyLogs).toHaveBeenCalledWith({
        limit: 50,
        offset: 0,
        status: 'all',
        search: '',
        siteId: 9,
        client: 'family:codex',
        from: expectedFrom,
        to: expectedTo,
      });

      const rendered = JSON.stringify(root!.toJSON());
      expect(rendered).toContain('main-site');
    } finally {
      root?.unmount();
    }
  });

  it('queries proxy debug traces with server-side filters and renders trace rows', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const inputs = root!.root.findAll((node) => node.type === 'input');
      const sessionIdInput = inputs.find((node) => node.props.placeholder === 'Session ID');
      expect(sessionIdInput).toBeDefined();
      await act(async () => {
        sessionIdInput!.props.onChange({ target: { value: 'turn-1' } });
      });

      const traceButton = root!.root.find((node) => node.props['data-testid'] === 'proxy-trace-query');
      await act(async () => {
        await traceButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getProxyDebugTraces).toHaveBeenCalledWith({
        sessionId: 'turn-1',
        traceId: undefined,
        traceHint: undefined,
        kind: undefined,
        siteId: undefined,
        limit: 50,
      });

      const rendered = JSON.stringify(root!.toJSON());
      expect(rendered).toContain('Proxy Trace 排障');
      expect(rendered).toContain('代理异常');
      expect(rendered).toContain('upstream timeout');
      expect(rendered).toContain('session:turn-1');
      expect(rendered).toContain('查看 detail');
    } finally {
      root?.unmount();
    }
  });
});
