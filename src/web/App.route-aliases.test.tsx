import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { MemoryRouter, useLocation } from 'react-router-dom';
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

vi.mock('./i18n.js', () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => children,
  useI18n: () => ({
    language: 'zh',
    toggleLanguage: vi.fn(),
    t: (text: string) => text,
  }),
}));

function RoutedProbe({ label }: { label: string }) {
  const location = useLocation();
  return <div>{`${label}:${location.pathname}`}</div>;
}

vi.mock('./pages/Dashboard.js', () => ({
  default: () => <div>dashboard</div>,
}));

vi.mock('./pages/TokenRoutes.js', () => ({
  default: () => <RoutedProbe label="routes" />,
}));

vi.mock('./pages/Monitors.js', () => ({
  default: () => <RoutedProbe label="monitor" />,
}));

vi.mock('./pages/CredentialDiagnostics.js', () => ({
  default: () => <RoutedProbe label="diagnostics" />,
}));

vi.mock('./pages/ProgramLogs.js', () => ({
  default: () => <RoutedProbe label="events" />,
}));

vi.mock('./pages/ImportExport.js', () => ({
  default: () => <RoutedProbe label="import-export" />,
}));

vi.mock('./pages/NotificationSettings.js', () => ({
  default: () => <RoutedProbe label="notifications" />,
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
  vi.stubGlobal('window', {
    innerWidth: 1280,
    matchMedia,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    location: {
      reload: vi.fn(),
      assign: vi.fn(),
    },
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
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('App route aliases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSessionMock.hasValidAuthSession.mockReturnValue(true);
    apiMock.getEvents.mockResolvedValue([]);
    apiMock.getRuntimeOverview.mockResolvedValue(null);
    setupRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['/token-routes', 'routes:/routes'],
    ['/monitors', 'monitor:/monitor'],
    ['/credential-diagnostics', 'diagnostics:/diagnostics'],
    ['/program-logs', 'events:/events'],
    ['/import-export', 'import-export:/settings/import-export'],
    ['/notifications', 'notifications:/settings/notify'],
  ])('redirects legacy alias %s to canonical path', async (entry, expectedText) => {
    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={[entry]}>
            <App />
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();
      expect(JSON.stringify(root!.toJSON())).toContain(expectedText);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });
});
