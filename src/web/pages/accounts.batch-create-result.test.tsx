import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import ModernSelect from '../components/ModernSelect.js';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getSites: vi.fn(),
    addAccount: vi.fn(),
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
    await Promise.resolve();
  });
}

describe('Accounts batch create result modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAccounts.mockResolvedValue([]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Demo Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.addAccount.mockResolvedValue({
      success: false,
      batch: true,
      total: 2,
      successCount: 1,
      failedCount: 1,
      successItems: [
        { id: 81, username: 'line-1', tokenType: 'apikey', queued: false },
      ],
      failedItems: [
        { value: 'sk-broken-abcdef', message: 'Invalid API key' },
      ],
      message: '批量创建完成：成功 1，失败 1',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows per-key batch creation results after adding multiple api keys', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const addButton = root!.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('+ 添加连接')
      ));
      await act(async () => {
        addButton.props.onClick();
      });
      await flushMicrotasks();

      const selects = root!.root.findAllByType(ModernSelect);
      await act(async () => {
        selects[1]!.props.onChange('10');
      });

      const textareas = root!.root.findAll((node) => node.type === 'textarea');
      await act(async () => {
        textareas[0]!.props.onChange({ target: { value: 'sk-demo-1\nsk-demo-2' } });
      });
      await act(async () => {
        textareas[1]!.props.onChange({ target: { value: 'sk-demo-1\nsk-demo-2' } });
      });

      const submitButton = root!.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('批量添加连接')
      ));
      await act(async () => {
        await submitButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.addAccount).toHaveBeenCalledTimes(1);
      const rendered = JSON.stringify(root!.toJSON());
      expect(rendered).toContain('批量 API Key 创建结果');
      expect(rendered).toContain('批量创建完成：成功 1，失败 1');
      expect(rendered).toContain('line-1');
      expect(rendered).toContain('Invalid API key');
      expect(rendered).toContain('sk-bro...cdef');
      expect(rendered).toContain('定位连接');
    } finally {
      root?.unmount();
    }
  });
});
