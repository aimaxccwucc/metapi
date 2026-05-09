import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ToastProvider } from '../components/Toast.js';
import SiteAccountsModal from './SiteAccountsModal.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getSiteDetail: vi.fn(),
    getAccountTokenValue: vi.fn(),
    addAccountToken: vi.fn(),
    updateAccountToken: vi.fn(),
    deleteAccountToken: vi.fn(),
    setDefaultAccountToken: vi.fn(),
    syncAccountTokens: vi.fn(),
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
    <ToastProvider>
      <SiteAccountsModal
        open
        siteId={10}
        siteName="Session Site"
        onClose={() => undefined}
        onSiteBalanceChange={() => undefined}
      />
    </ToastProvider>,
  );
}

describe('SiteAccountsModal site detail tabs', () => {
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
        siteId: 10,
        username: 'session-user',
        accessToken: 'session-token',
        apiToken: null,
        status: 'active',
        balance: 1.23,
        capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
        site: { id: 10, name: 'Session Site', platform: 'new-api', status: 'active', url: 'https://session.example.com' },
      },
    ]);
    apiMock.getSiteDetail.mockResolvedValue({
      summary: {
        accountCount: 1,
        tokenCount: 1,
        modelCount: 1,
        groupCount: 1,
      },
      tokens: [
        {
          id: 22,
          accountId: 1,
          accountName: 'session-user',
          name: 'vip-key',
          group: 'vip',
          enabled: true,
          isDefault: true,
          valueStatus: 'ready',
          tokenMasked: 'sk-vip****',
          modelCount: 1,
          models: ['gpt-4o-mini'],
        },
      ],
      models: [
        {
          name: 'gpt-4o-mini',
          accountCount: 1,
          tokenCount: 1,
          groups: [
            {
              group: 'vip',
              accountCount: 1,
              tokenCount: 1,
              tokens: [
                { id: 22, name: 'vip-key', accountId: 1, accountName: 'session-user', enabled: true, isDefault: true },
              ],
            },
          ],
        },
      ],
      groups: [
        {
          group: 'vip',
          modelCount: 1,
          accountCount: 1,
          tokenCount: 1,
          models: ['gpt-4o-mini'],
        },
      ],
    });
    apiMock.getAccountTokenValue.mockResolvedValue({
      success: true,
      token: 'sk-real-value',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows model/group detail and copies keys from the site-scoped manager', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = buildRoot();
      });
      await flushMicrotasks();

      const modelTab = root.root.findAll((node) => node.type === 'button')
        .find((node) => collectText(node).includes('模型分组'));
      expect(modelTab).toBeTruthy();

      await act(async () => {
        modelTab!.props.onClick();
      });
      await flushMicrotasks();

      let rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('模型到分组与 Key');
      expect(rendered).toContain('gpt-4o-mini');
      expect(rendered).toContain('vip');

      const keyTab = root.root.findAll((node) => node.type === 'button')
        .find((node) => collectText(node).includes('Key 管理'));
      expect(keyTab).toBeTruthy();

      await act(async () => {
        keyTab!.props.onClick();
      });
      await flushMicrotasks();

      rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('vip-key');
      expect(rendered).toContain('sk-vip****');

      const copyButton = root.root.findAll((node) => node.type === 'button')
        .find((node) => collectText(node) === '复制');
      expect(copyButton).toBeTruthy();

      await act(async () => {
        copyButton!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getAccountTokenValue).toHaveBeenCalledWith(22);
      expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith('sk-real-value');
    } finally {
      root?.unmount();
    }
  });
});
