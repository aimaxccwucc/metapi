import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
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

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Accounts manual checkin focus intent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        siteId: 10,
        username: 'tester',
        accessToken: 'session-token',
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

  it('opens manual checkin modal when focus intent requests it', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?focusAccountId=1&openManualCheckin=1']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root!.toJSON());
      expect(rendered).toContain('人工处理签到');
      expect(rendered).toContain('打开签到页');
      expect(rendered).toContain('重试签到');
    } finally {
      root?.unmount();
    }
  });
});
