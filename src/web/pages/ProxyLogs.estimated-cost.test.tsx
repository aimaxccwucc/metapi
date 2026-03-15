import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ToastProvider } from '../components/Toast.js';
import ProxyLogs from './ProxyLogs.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getProxyLogs: vi.fn(),
    getProxyVideoTasks: vi.fn(),
    getSites: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
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

describe('ProxyLogs estimated cost display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getProxyVideoTasks.mockResolvedValue([]);
    apiMock.getSites.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('marks unestimated media requests as unavailable in row and summary', async () => {
    apiMock.getProxyLogs.mockResolvedValue({
      items: [
        {
          id: 1,
          createdAt: '2026-03-09T10:00:00.000Z',
          modelRequested: 'gpt-image-1',
          modelActual: 'gpt-image-1',
          status: 'success',
          latencyMs: 1200,
          totalTokens: 0,
          retryCount: 0,
          errorMessage: '',
          promptTokens: 0,
          completionTokens: 0,
          estimatedCost: 0,
        },
      ],
      total: 1,
      summary: {
        totalCount: 1,
        successCount: 1,
        failedCount: 0,
        totalCost: 0,
        totalTokensAll: 0,
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/proxy-logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('\u6d88\u8017\u603b\u989d');
      expect(text).toContain('$0.0000');
      expect(text).toContain('$0.000000');
    } finally {
      root?.unmount();
    }
  });

  it('excludes unestimated media requests from the total cost summary', async () => {
    apiMock.getProxyLogs.mockResolvedValue({
      items: [
        {
          id: 1,
          createdAt: '2026-03-09T10:00:00.000Z',
          modelRequested: 'gpt-image-1',
          modelActual: 'gpt-image-1',
          status: 'success',
          latencyMs: 1200,
          totalTokens: 0,
          retryCount: 0,
          errorMessage: '',
          promptTokens: 0,
          completionTokens: 0,
          estimatedCost: 0,
        },
        {
          id: 2,
          createdAt: '2026-03-09T11:00:00.000Z',
          modelRequested: 'gpt-4o-mini',
          modelActual: 'gpt-4o-mini',
          status: 'success',
          latencyMs: 800,
          totalTokens: 100,
          retryCount: 0,
          errorMessage: '',
          promptTokens: 40,
          completionTokens: 60,
          estimatedCost: 0.123456,
        },
      ],
      total: 2,
      summary: {
        totalCount: 2,
        successCount: 2,
        failedCount: 0,
        totalCost: 0.123456,
        totalTokensAll: 100,
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/proxy-logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('$0.1235');
      expect(text).toContain('$0.000000');
    } finally {
      root?.unmount();
    }
  });
});
