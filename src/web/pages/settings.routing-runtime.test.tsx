import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Settings from './Settings.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthInfo: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getDownstreamApiKeys: vi.fn(),
    getRoutesLite: vi.fn(),
    getRuntimeDatabaseConfig: vi.fn(),
    resetRoutingRuntimeState: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon,
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

describe('Settings routing runtime reset', () => {
  const confirmMock = vi.fn(() => true);

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '0 6 * * *',
      logCleanupUsageLogsEnabled: false,
      logCleanupProgramLogsEnabled: false,
      logCleanupRetentionDays: 30,
      routingFallbackUnitCost: 1,
      routingWeights: {},
      adminIpAllowlist: [],
      systemProxyUrl: '',
    });
    apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.resetRoutingRuntimeState.mockResolvedValue({
      success: true,
      updatedChannels: 3,
      clearedModelCircuits: 2,
      clearedPersistedSiteRuntimeState: true,
    });

    Object.defineProperty(globalThis, 'window', {
      value: {
        confirm: confirmMock,
        location: { reload: vi.fn() },
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls resetRoutingRuntimeState after confirmation', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const resetButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '清理路由运行时状态'
      ));

      await act(async () => {
        resetButton.props.onClick();
      });
      await flushMicrotasks();

      expect(confirmMock).toHaveBeenCalledTimes(1);
      expect(apiMock.resetRoutingRuntimeState).toHaveBeenCalledTimes(1);
    } finally {
      root?.unmount();
    }
  });
});
