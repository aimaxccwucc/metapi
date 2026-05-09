import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import App from './App.js';

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

vi.mock('./i18n.js', async () => {
  const actual = await vi.importActual<typeof import('./i18n.js')>('./i18n.js');
  return {
    ...actual,
    I18nProvider: ({ children }: { children: ReactNode }) => children,
    useI18n: () => ({
      language: 'zh',
      toggleLanguage: vi.fn(),
      t: (text: string) => text,
    }),
  };
});

vi.mock('./pages/Dashboard.js', () => ({
  default: () => {
    throw new Error('dashboard render exploded');
  },
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

function setupRuntime() {
  const matchMedia = (query: string) => ({
    matches: query.includes('prefers-color-scheme') ? false : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  });

  vi.stubGlobal('localStorage', createLocalStorage());
  const location = {
    href: 'https://metapi.test/',
    pathname: '/',
    reload: vi.fn(),
    assign: vi.fn(),
  };
  vi.stubGlobal('window', {
    innerWidth: 1280,
    matchMedia,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    localStorage,
    location,
  });
  vi.stubGlobal('document', {
    body: { style: {} },
    documentElement: {
      setAttribute: vi.fn(),
      getAttribute: vi.fn(),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return { location };
}

function collectText(node: any): string {
  return (node.children || []).map((child: any) => {
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

describe('App route error boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    authSessionMock.hasValidAuthSession.mockReturnValue(true);
    apiMock.getEvents.mockResolvedValue([]);
    apiMock.getRuntimeOverview.mockResolvedValue(null);
    setupRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows a recoverable error state instead of blanking the app when a route crashes', async () => {
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

      const text = collectText(root!.root);
      expect(text).toContain('页面加载失败');
      expect(text).toContain('dashboard render exploded');
      expect(text).toContain('重试当前页');
      expect(text).toContain('返回仪表盘');
    } finally {
      root?.unmount();
    }
  });

  it('reloads once when a route chunk cannot be dynamically imported', async () => {
    vi.doMock('./pages/Dashboard.js', () => ({
      default: () => {
        throw new Error('Failed to fetch dynamically imported module: https://metapi.test/assets/Dashboard-old.js');
      },
    }));
    vi.resetModules();
    const { default: ReloadingApp } = await import('./App.js');
    const runtime = setupRuntime();

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/']}>
            <ReloadingApp />
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(runtime.location.reload).toHaveBeenCalledTimes(1);
    } finally {
      root?.unmount();
    }
  });
});
