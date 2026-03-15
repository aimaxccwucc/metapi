import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getSites: vi.fn(),
    getAccountTokens: vi.fn(),
    getAccountTokenValue: vi.fn(),
    getAccountTokenGroups: vi.fn(),
    updateAccountToken: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children
    .map((child) => {
      if (typeof child === 'string') return child;
      return collectText(child);
    })
    .join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buildRoot() {
  return create(
    <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
      <ToastProvider>
        <Accounts />
      </ToastProvider>
    </MemoryRouter>,
    {
      createNodeMock: (element) => {
        if (element.type === 'tr' || element.type === 'div') {
          return {
            scrollIntoView: () => undefined,
          };
        }
        return {};
      },
    },
  );
}

describe('Tokens edit modal and row selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      },
      configurable: true,
      writable: true,
    });
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'session-user',
        accessToken: 'session-token',
        status: 'active',
        credentialMode: 'session',
        capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
        site: { id: 10, name: 'Session Site', platform: 'new-api', status: 'active', url: 'https://session.example.com' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Session Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([
      {
        id: 22,
        name: 'focus-token',
        tokenMasked: 'sk-focus****',
        enabled: true,
        isDefault: false,
        updatedAt: '2026-03-07 10:00:00',
        accountId: 1,
        account: { username: 'session-user' },
        site: { name: 'Session Site', url: 'https://session.example.com' },
      },
    ]);
    apiMock.getAccountTokenValue.mockResolvedValue({
      success: true,
      token: 'sk-focus-real',
    });
    apiMock.getAccountTokenGroups.mockResolvedValue({
      success: true,
      groups: ['default', 'vip'],
    });
    apiMock.updateAccountToken.mockResolvedValue({
      success: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens the centered edit modal when editing a token', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = buildRoot();
      });
      await flushMicrotasks();

      const editButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => collectText(node).includes('编辑'));
      expect(editButton).toBeTruthy();

      await act(async () => {
        editButton!.props.onClick({ stopPropagation: () => undefined });
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('编辑令牌');
      expect(rendered).toContain('保存修改');
      expect(rendered).toContain('sk-focus-real');
      expect(rendered).toContain('基本信息');
      expect(rendered).toContain('状态设置');
      expect(rendered).toContain('分组');
      const modals = root.root.findAll((node) => {
        const className = typeof node.props?.className === 'string' ? node.props.className : '';
        return className.includes('modal-content') && collectText(node).includes('编辑令牌');
      });
      expect(modals).toHaveLength(1);
      expect(apiMock.getAccountTokenGroups).toHaveBeenCalledWith(1);

      const saveButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => collectText(node).includes('保存修改'));
      expect(saveButton).toBeTruthy();

      await act(async () => {
        saveButton!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateAccountToken).toHaveBeenCalledWith(22, expect.objectContaining({ group: 'default' }));
    } finally {
      root?.unmount();
    }
  });

  it('selects a token when clicking the row body, but not when clicking an action button', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = buildRoot();
      });
      await flushMicrotasks();

      const tokenRow = root.root.findAll((node) => {
        if (node.type !== 'tr') return false;
        return collectText(node).includes('focus-token');
      })[0];
      expect(tokenRow).toBeTruthy();

      await act(async () => {
        tokenRow.props.onClick({
          target: { closest: () => null },
        });
      });
      await flushMicrotasks();

      expect(JSON.stringify(root.toJSON())).toContain('已选 ');
      expect(JSON.stringify(root.toJSON())).toContain('"1"');

      const copyButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => collectText(node).includes('复制'));
      expect(copyButton).toBeTruthy();

      await act(async () => {
        copyButton!.props.onClick({ stopPropagation: () => undefined });
      });
      await flushMicrotasks();

      expect(JSON.stringify(root.toJSON())).toContain('已选 ');
      expect(JSON.stringify(root.toJSON())).toContain('"1"');
    } finally {
      root?.unmount();
    }
  });

  it('does not repeatedly refetch groups when edit-group loading fails once', async () => {
    apiMock.getAccountTokenGroups.mockRejectedValueOnce(new Error('账号会话可能已过期，请重新登录后再拉取分组'));

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = buildRoot();
      });
      await flushMicrotasks();

      const editButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => collectText(node).includes('编辑'));
      expect(editButton).toBeTruthy();

      await act(async () => {
        editButton!.props.onClick({ stopPropagation: () => undefined });
      });

      await flushMicrotasks();
      await flushMicrotasks();

      expect(apiMock.getAccountTokenGroups).toHaveBeenCalledTimes(1);
    } finally {
      root?.unmount();
    }
  });
});
