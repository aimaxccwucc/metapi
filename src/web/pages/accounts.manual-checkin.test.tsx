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

describe('Accounts manual checkin panel', () => {
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens the manual checkin panel from row actions', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
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

      const manualButton = root.root.find((node) => (
        node.type === 'button'
        && node.props['data-testid'] === 'account-manual-checkin-1'
      ));

      await act(async () => {
        manualButton.props.onClick();
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('人工处理签到');
      expect(rendered).toContain('打开签到页');
      expect(rendered).toContain('重试签到');
      expect(rendered).toContain('重新绑定 Session');
      expect(rendered).toContain('https://checkin.example.com/welfare');
    } finally {
      root?.unmount();
    }
  });
});
