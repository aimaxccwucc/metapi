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

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => false,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: ReactTestInstance): string {
  return (node.children || [])
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

function getRowNames(root: ReturnType<typeof create>) {
  return root.root
    .findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('account-row-'))
    .map((node) => collectText(node));
}

describe('Accounts desktop table sorting', () => {
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
        balance: 1,
        sortOrder: 0,
        site: { id: 1, name: 'Site A', platform: 'new-api', status: 'active' },
        runtimeHealth: { state: 'healthy', reason: 'ok' },
      },
      {
        id: 2,
        siteId: 1,
        username: 'beta',
        accessToken: 'session-beta',
        status: 'active',
        balance: 10,
        sortOrder: 1,
        site: { id: 1, name: 'Site A', platform: 'new-api', status: 'active' },
        runtimeHealth: { state: 'unhealthy', reason: 'boom' },
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sorts by balance and runtime health from table headers', async () => {
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

      expect(getRowNames(root!)[0]).toContain('alpha');

      const balanceHeader = root!.root.find((node) => node.props['data-testid'] === 'accounts-sort-balance');
      await act(async () => {
        balanceHeader.props.onClick();
      });
      await flushMicrotasks();
      expect(getRowNames(root!)[0]).toContain('beta');

      await act(async () => {
        balanceHeader.props.onClick();
      });
      await flushMicrotasks();
      expect(getRowNames(root!)[0]).toContain('alpha');

      const healthHeader = root!.root.find((node) => node.props['data-testid'] === 'accounts-sort-runtime-health');
      await act(async () => {
        healthHeader.props.onClick();
      });
      await flushMicrotasks();
      expect(getRowNames(root!)[0]).toContain('beta');

      await act(async () => {
        healthHeader.props.onClick();
      });
      await flushMicrotasks();
      expect(getRowNames(root!)[0]).toContain('alpha');
    } finally {
      root?.unmount();
    }
  });
});
