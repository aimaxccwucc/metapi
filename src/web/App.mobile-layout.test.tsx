import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import App from './App.js';
import {
  APP_INSTALL_BANNER_DISMISSED_KEY,
  APP_INSTALL_IOS_HINT_DISMISSED_KEY,
} from './appLocalState.js';

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
    ['theme_mode', 'light'],
    ['metapi_first_use_docs_reminder_seen_v1', '1'],
    ['user_profile', JSON.stringify({
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
  const listeners = new Map<string, Set<(event?: Event) => void>>();
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36';
  const matchMedia = (query: string) => ({
    matches: query.includes('prefers-color-scheme')
      ? false
      : (query.includes('display-mode: standalone') ? false : width <= 768),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  });

  const documentElementAttributes = new Map<string, string>();
  const documentElement = {
    setAttribute: (name: string, value: string) => {
      documentElementAttributes.set(name, value);
    },
    getAttribute: (name: string) => documentElementAttributes.get(name) ?? null,
  };

  vi.stubGlobal('localStorage', createLocalStorage());
  vi.stubGlobal('window', {
    innerWidth: width,
    matchMedia,
    addEventListener: vi.fn((name: string, handler: (event?: Event) => void) => {
      const bucket = listeners.get(name) || new Set();
      bucket.add(handler);
      listeners.set(name, bucket);
    }),
    removeEventListener: vi.fn((name: string, handler: (event?: Event) => void) => {
      listeners.get(name)?.delete(handler);
    }),
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent,
      serviceWorker: {
        register: vi.fn().mockResolvedValue(undefined),
      },
    },
    configurable: true,
    writable: true,
  });
  vi.stubGlobal('document', {
    body: { style: {} },
    documentElement,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });

  return {
    dispatchWindowEvent(name: string, event?: Event) {
      const bucket = listeners.get(name);
      if (!bucket) return;
      for (const handler of bucket) {
        handler(event);
      }
    },
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('App mobile layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    apiMock.getEvents.mockResolvedValue([]);
    apiMock.getRuntimeOverview.mockResolvedValue({
      database: { ready: true, dialect: 'sqlite' },
      backgroundTasks: { total: 0, pending: 0, running: 0, failed: 0 },
      recentActivity: { proxyRequests24h: 0, proxyFailures24h: 0, unreadEvents: 0 },
    });
    authSessionMock.hasValidAuthSession.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    { width: 767, expectedLayout: 'mobile', hasHamburger: true },
    { width: 768, expectedLayout: 'mobile', hasHamburger: true },
    { width: 769, expectedLayout: 'desktop', hasHamburger: false },
  ])(
    'uses the shared breakpoint at width $width',
    async ({ width, expectedLayout, hasHamburger }) => {
      setupRuntime(width);
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

        const hamburgerButtons = root.root.findAll((node) => (
          node.type === 'button'
          && node.props['aria-label'] === '打开导航'
        ));

        expect(document.documentElement.getAttribute('data-layout')).toBe(expectedLayout);
        expect(hamburgerButtons.length > 0).toBe(hasHamburger);
      } finally {
        if (root) {
          await act(async () => {
            root.unmount();
          });
        }
      }
    },
  );

  it('shows native install banner after beforeinstallprompt and persists dismissal', async () => {
    const runtime = setupRuntime(390);
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

      const prompt = {
        preventDefault: vi.fn(),
        prompt: vi.fn().mockResolvedValue(undefined),
        userChoice: Promise.resolve({ outcome: 'dismissed' as const, platform: 'web' }),
      };

      await act(async () => {
        runtime.dispatchWindowEvent('beforeinstallprompt', prompt as unknown as Event);
      });
      await flushMicrotasks();

      const banner = root.root.findAll((node) => node.props['data-testid'] === 'app-install-banner');
      expect(banner).toHaveLength(1);

      const installButton = root.root.find((node) => (
        node.type === 'button'
        && Array.isArray(node.children)
        && node.children.join('') === '立即安装'
      ));

      await act(async () => {
        await installButton.props.onClick();
      });
      await flushMicrotasks();

      expect(prompt.prompt).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(APP_INSTALL_BANNER_DISMISSED_KEY)).toBe('1');
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });

  it('shows ios install hint and dismisses it locally', async () => {
    const runtime = setupRuntime(390);
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
        serviceWorker: {
          register: vi.fn().mockResolvedValue(undefined),
        },
      },
      configurable: true,
      writable: true,
    });

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

      const banner = root.root.findAll((node) => node.props['data-testid'] === 'app-install-banner');
      expect(banner).toHaveLength(1);

      const dismissButton = root.root.find((node) => (
        node.type === 'button'
        && Array.isArray(node.children)
        && node.children.join('') === '稍后再说'
      ));

      await act(async () => {
        dismissButton.props.onClick();
      });
      await flushMicrotasks();

      expect(localStorage.getItem(APP_INSTALL_IOS_HINT_DISMISSED_KEY)).toBe('1');
      expect(root.root.findAll((node) => node.props['data-testid'] === 'app-install-banner')).toHaveLength(0);

      void runtime;
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });
});
