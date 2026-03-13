import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getSites: vi.fn(),
    updateAccount: vi.fn(),
    refreshAccountHealth: vi.fn(),
    checkModels: vi.fn(),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    toast: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  useToast: () => toastMock,
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

describe('Accounts edit panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      { id: 1, name: 'Site A', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        siteId: 1,
        username: 'alpha',
        accessToken: 'session-alpha',
        status: 'active',
        site: { id: 1, name: 'Site A', status: 'active', platform: 'new-api' },
      },
    ]);
    apiMock.updateAccount.mockResolvedValue({ success: true });
    apiMock.refreshAccountHealth.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens edit panel from account row action', async () => {
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

      const editButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '编辑'
      ));

      await act(async () => {
        editButton.props.onClick();
      });
      await flushMicrotasks();

      const usernameInput = root.root.find((node) => (
        node.type === 'input'
        && node.props.placeholder === '账号名称'
      ));
      expect(usernameInput.props.value).toBe('alpha');
    } finally {
      root?.unmount();
    }
  });

  it('shows model refresh toast on success', async () => {
    apiMock.checkModels.mockResolvedValue({
      refresh: {
        status: 'success',
        modelCount: 2,
        modelsPreview: ['gpt-4', 'gpt-3.5'],
      },
    });

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

      const modelButtons = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn-link-info')
        && collectText(node).trim() === '模型'
      ));
      expect(modelButtons.length).toBeGreaterThan(0);

      await act(async () => {
        await modelButtons[0]!.props.onClick();
      });
      await flushMicrotasks();

      expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('已获取到模型'));
      expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('（共 2 个）'));
    } finally {
      root?.unmount();
    }
  });
});
