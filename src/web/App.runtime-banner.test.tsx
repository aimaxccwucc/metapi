import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import App from './App.js';
import { APP_VERSION_RELOAD_STORAGE_KEY } from './appVersion.js';

const { apiMock, authSessionMock } = vi.hoisted(() => ({
  apiMock: {
    getEvents: vi.fn(),
    getRuntimeOverview: vi.fn(),
  },
  authSessionMock: {
    hasValidAuthSession: vi.fn(),
    persistAuthSession: vi.fn(),
    clearAuthSession: vi.fn(),
  },
}));

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (node: unknown) => node,
  };
});

vi.mock('./api.js', () => ({
  api: apiMock,
}));

vi.mock('./authSession.js', () => ({
  hasValidAuthSession: authSessionMock.hasValidAuthSession,
  persistAuthSession: authSessionMock.persistAuthSession,
  clearAuthSession: authSessionMock.clearAuthSession,
}));

vi.mock('./components/SearchModal.js', () => ({
  default: () => null,
}));

vi.mock('./components/NotificationPanel.js', () => ({
  default: () => null,
}));

vi.mock('./components/TooltipLayer.js', () => ({
  default: () => null,
}));

vi.mock('./components/useAnimatedVisibility.js', () => ({
  useAnimatedVisibility: (open: boolean) => ({
    shouldRender: open,
    isVisible: open,
  }),
}));

vi.mock('./i18n.js', () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => children,
  useI18n: () => ({
    language: 'zh',
    toggleLanguage: vi.fn(),
    t: (text: string) => text,
  }),
}));

vi.mock('./pages/Dashboard.js', () => ({
  default: ({ adminName }: { adminName?: string }) => <div>{adminName || 'Dashboard'}</div>,
}));

function createLocalStorage() {
  const store = new Map<string, string>([
    ['metapi.theme.mode', 'light'],
    ['metapi.firstUseDocReminder', '1'],
    ['metapi.userProfile', JSON.stringify({
      name: '管理员',
      avatarSeed: 'seed-1',
      avatarStyle: 'identicon',
    })],
  ]);

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

function setupRuntime(width: number) {
  const location = {
    href: 'https://metapi.test/accounts',
    pathname: '/accounts',
    reload: vi.fn(),
  };
  const matchMedia = (query: string) => ({
    matches: query.includes('prefers-color-scheme')
      ? false
      : width <= 768,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  });

  vi.stubGlobal('localStorage', createLocalStorage());
  vi.stubGlobal('window', {
    innerWidth: width,
    location,
    matchMedia,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', {
    body: { style: {} },
    documentElement: {
      setAttribute: vi.fn(),
      getAttribute: vi.fn(),
    },
    baseURI: 'https://metapi.test/accounts',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelectorAll: vi.fn((selector: string) => {
      if (selector === 'script[src]') {
        return [{
          getAttribute: (name: string) => (name === 'src' ? '/assets/index-old.js' : null),
          src: 'https://metapi.test/assets/index-old.js',
        }];
      }
      return [];
    }),
  });

  return { location };
}

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

function buildOverview(input: {
  databaseReady?: boolean;
  failedTasks?: number;
  runningTasks?: number;
  unreadEvents?: number;
  proxyFailures24h?: number;
  proxyRequests24h?: number;
}) {
  return {
    database: { ready: input.databaseReady ?? true, dialect: 'sqlite' },
    backgroundTasks: {
      total: (input.failedTasks ?? 0) + (input.runningTasks ?? 0),
      pending: 0,
      running: input.runningTasks ?? 0,
      failed: input.failedTasks ?? 0,
    },
    recentActivity: {
      proxyRequests24h: input.proxyRequests24h ?? 0,
      proxyFailures24h: input.proxyFailures24h ?? 0,
      unreadEvents: input.unreadEvents ?? 0,
    },
  };
}

describe('App runtime banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    authSessionMock.hasValidAuthSession.mockReturnValue(true);
    apiMock.getEvents.mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/accounts') {
        return {
          ok: true,
          text: async () => '<html><head><script type="module" src="/assets/index-new.js"></script></head></html>',
        };
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }));
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not render the legacy global runtime banner anymore', async () => {
    setupRuntime(1280);
    apiMock.getRuntimeOverview.mockResolvedValue(buildOverview({
      databaseReady: false,
      failedTasks: 3,
      unreadEvents: 8,
      proxyFailures24h: 90,
      proxyRequests24h: 200,
    }));

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/']}>
            <App />
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const banners = root.root.findAll((node) => (
        typeof node.props?.['data-testid'] === 'string'
        && node.props['data-testid'] === 'app-runtime-banner'
      ));
      expect(banners).toHaveLength(0);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });

  it('does not surface task failure copy in the removed global banner area', async () => {
    setupRuntime(1280);
    apiMock.getRuntimeOverview.mockResolvedValue(buildOverview({
      failedTasks: 2,
      runningTasks: 1,
      unreadEvents: 6,
      proxyFailures24h: 35,
      proxyRequests24h: 140,
    }));

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/']}>
            <App />
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const pageText = collectText(root.root);
      expect(pageText).not.toContain('后台任务存在失败');
      expect(pageText).not.toContain('存在未读状态事件');
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });

  it('keeps mobile layout without rendering the removed runtime banner', async () => {
    setupRuntime(768);
    apiMock.getRuntimeOverview.mockResolvedValue(buildOverview({
      unreadEvents: 4,
    }));

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/']}>
            <App />
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const banners = root.root.findAll((node) => (
        typeof node.props?.className === 'string'
        && node.props.className.includes('app-runtime-banner')
      ));
      expect(banners).toHaveLength(0);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });

  it('does not show the removed runtime banner for elevated proxy failures', async () => {
    setupRuntime(1280);
    apiMock.getRuntimeOverview.mockResolvedValue(buildOverview({
      proxyFailures24h: 24,
      proxyRequests24h: 120,
    }));

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/']}>
            <App />
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const pageText = collectText(root.root);
      expect(pageText).not.toContain('24 小时请求失败偏高');
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });

  it('reloads once when the current page is still running an old bundle after deployment', async () => {
    const { location } = setupRuntime(1280);
    apiMock.getRuntimeOverview.mockResolvedValue(buildOverview({}));

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <App />
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(location.reload).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(APP_VERSION_RELOAD_STORAGE_KEY)).toBe('/assets/index-new.js');
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });
});
