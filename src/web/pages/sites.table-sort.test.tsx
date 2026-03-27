import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Sites from './Sites.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
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
    .findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('site-row-'))
    .map((node) => collectText(node));
}

describe('Sites desktop table sorting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Site Alpha',
        url: 'https://alpha.example.com',
        platform: 'new-api',
        status: 'active',
        totalBalance: 1,
        sortOrder: 0,
        healthStatus: 'alive',
      },
      {
        id: 2,
        name: 'Site Beta',
        url: 'https://beta.example.com',
        platform: 'new-api',
        status: 'active',
        totalBalance: 10,
        sortOrder: 1,
        healthStatus: 'unreachable',
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sorts by balance and reachability from table headers', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(getRowNames(root!)[0]).toContain('Site Alpha');

      const balanceHeader = root!.root.find((node) => node.props['data-testid'] === 'sites-sort-balance');
      await act(async () => {
        balanceHeader.props.onClick();
      });
      await flushMicrotasks();
      expect(getRowNames(root!)[0]).toContain('Site Beta');

      await act(async () => {
        balanceHeader.props.onClick();
      });
      await flushMicrotasks();
      expect(getRowNames(root!)[0]).toContain('Site Alpha');

      const reachabilityHeader = root!.root.find((node) => node.props['data-testid'] === 'sites-sort-reachability');
      await act(async () => {
        reachabilityHeader.props.onClick();
      });
      await flushMicrotasks();
      expect(getRowNames(root!)[0]).toContain('Site Beta');

      await act(async () => {
        reachabilityHeader.props.onClick();
      });
      await flushMicrotasks();
      expect(getRowNames(root!)[0]).toContain('Site Alpha');
    } finally {
      root?.unmount();
    }
  });
});
