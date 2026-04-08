import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
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

async function renderAccountsPage() {
  let root: ReturnType<typeof create> | null = null;
  await act(async () => {
    root = create(
      <MemoryRouter initialEntries={['/accounts']}>
        <ToastProvider>
          <Accounts />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();
  return root!;
}

async function openManualCheckinPanel(root: ReturnType<typeof create>) {
  const manualButton = root.root.find((node) => (
    node.type === 'button'
    && node.props['data-testid'] === 'account-manual-checkin-1'
  ));

  await act(async () => {
    manualButton.props.onClick();
  });
  await flushMicrotasks();
}

describe('Accounts manual checkin panel', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        siteId: 10,
        username: 'tester',
        accessToken: 'session-token',
        balance: 0,
        balanceUsed: 0,
        todayReward: 0,
        todaySpend: 0,
        status: 'active',
        checkinEnabled: true,
        site: {
          id: 10,
          name: 'Demo Site',
          status: 'active',
          platform: 'new-api',
          url: 'https://example.com',
          externalCheckinUrl: 'https://checkin.example.com/welfare',
          autoCheckinPolicy: 'manual_required',
          autoCheckinReason: '站点开启了 Turnstile 人机验证，自动签到无法直接通过。',
        },
        runtimeHealth: { state: 'healthy', reason: 'ok' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Demo Site', platform: 'new-api', status: 'active' },
    ]);
    vi.stubGlobal('window', {
      ...(originalWindow || {}),
      innerWidth: 1280,
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: {
        ...(originalWindow?.location || {}),
        assign: vi.fn(),
      },
      open: vi.fn(() => ({ closed: false })),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalWindow) {
      vi.stubGlobal('window', originalWindow);
    } else {
      vi.unstubAllGlobals();
    }
  });

  it('opens the manual checkin panel from row actions', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      root = await renderAccountsPage();
      await openManualCheckinPanel(root);

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('人工处理签到');
      expect(rendered).toContain('打开签到页');
      expect(rendered).toContain('复制签到页链接');
      expect(rendered).toContain('重试签到');
      expect(rendered).toContain('重新绑定 Session');
      expect(rendered).toContain('https://checkin.example.com/welfare');
      expect(rendered).toContain('https://example.com');
    } finally {
      root?.unmount();
    }
  });

  it('opens the checkin url via window.open when available', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      root = await renderAccountsPage();
      await openManualCheckinPanel(root);

      const openButton = root.root.find((node) => (
        node.type === 'button'
        && collectText(node) === '打开签到页'
      ));

      await act(async () => {
        openButton.props.onClick();
      });
      await flushMicrotasks();

      expect(globalThis.window.open).toHaveBeenCalledWith(
        'https://checkin.example.com/welfare',
        '_blank',
        'noopener,noreferrer',
      );
    } finally {
      root?.unmount();
    }
  });

  it('keeps clickable fallback links visible when popup opening is blocked', async () => {
    vi.stubGlobal('window', {
      ...(originalWindow || {}),
      innerWidth: 1280,
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: {
        ...(originalWindow?.location || {}),
        assign: vi.fn(),
      },
      open: vi.fn(() => null),
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      root = await renderAccountsPage();
      await openManualCheckinPanel(root);

      const openButton = root.root.find((node) => (
        node.type === 'button'
        && collectText(node) === '打开签到页'
      ));

      await act(async () => {
        openButton.props.onClick();
      });
      await flushMicrotasks();

      const checkinLink = root.root.find((node) => (
        node.type === 'a'
        && node.props['data-testid'] === 'manual-checkin-link'
      ));
      const siteLink = root.root.find((node) => (
        node.type === 'a'
        && node.props['data-testid'] === 'manual-site-link'
      ));

      expect(checkinLink.props.href).toBe('https://checkin.example.com/welfare');
      expect(siteLink.props.href).toBe('https://example.com');
      expect(JSON.stringify(root.toJSON())).toContain('请直接点击下方链接或复制入口地址');
      expect(globalThis.window.location.assign).toHaveBeenCalledWith('https://checkin.example.com/welfare');
    } finally {
      root?.unmount();
    }
  });
});
