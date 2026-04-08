import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import CheckinLog from './CheckinLog.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getCheckinLogs: vi.fn(),
    triggerCheckinAll: vi.fn(),
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

function buildLog(id: number) {
  return {
    checkin_logs: {
      id,
      status: 'success',
      message: `checkin-${id}`,
      reward: `${id}`,
      createdAt: '2026-04-08 01:00:00',
    },
    accounts: {
      username: `user-${id}`,
    },
    sites: {
      name: `site-${id}`,
      url: `https://site-${id}.example.com`,
    },
    failureReason: null,
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CheckinLog pagination', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T12:00:00.000Z'));
    apiMock.triggerCheckinAll.mockResolvedValue({ queued: true, message: 'ok' });
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
      location: originalWindow?.location,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    if (originalWindow) {
      vi.stubGlobal('window', originalWindow);
    } else {
      vi.unstubAllGlobals();
    }
  });

  it('loads all checkin logs automatically after the initial 100 rows', async () => {
    apiMock.getCheckinLogs
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => buildLog(index + 1)))
      .mockResolvedValueOnce(Array.from({ length: 20 }, (_, index) => buildLog(index + 101)));

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/checkin']}>
            <ToastProvider>
              <CheckinLog />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(apiMock.getCheckinLogs).toHaveBeenNthCalledWith(1, 'limit=100&offset=0');
      expect(apiMock.getCheckinLogs).toHaveBeenNthCalledWith(2, 'limit=100&offset=100');
      expect(collectText(root!.root)).toContain('已加载 120 条签到记录，当前筛选命中 120 条。');
      expect(collectText(root!.root)).toContain('user-120');
      expect(collectText(root!.root)).toContain('页面会自动分批拉取最近全部签到记录。');
      expect(collectText(root!.root)).not.toContain('加载更多签到记录');
    } finally {
      root?.unmount();
    }
  });
});
