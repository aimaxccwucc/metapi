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
    updateRuntimeSettings: vi.fn(),
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

function hasNodeText(node: ReactTestInstance, text: string): boolean {
  return collectText(node).includes(text);
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Settings proxy failure rules', () => {
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
      disableCrossProtocolFallback: false,
      globalAllowedModels: ['gpt-*'],
      proxyDebugTraceEnabled: false,
      proxyDebugTraceMaxEntries: 300,
      proxyErrorKeywords: ['rate limit'],
      proxyEmptyContentFailEnabled: true,
    });
    apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({
      disableCrossProtocolFallback: true,
      globalAllowedModels: ['gpt-*', 'claude-sonnet-*'],
      proxyDebugTraceEnabled: true,
      proxyDebugTraceMaxEntries: 640,
      proxyErrorKeywords: ['rate limit', 'quota exceeded'],
      proxyEmptyContentFailEnabled: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('saves gateway runtime flags together with failure rule settings', async () => {
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

      const failureRulesCard = root.root.find((node) => (
        typeof node.type === 'string'
        && typeof node.props?.className === 'string'
        && node.props.className.includes('card')
        && node.props.className.includes('surface-card')
        && hasNodeText(node, '代理失败判定')
      ));

      const checkboxes = failureRulesCard.findAll((node) => node.type === 'input' && node.props.type === 'checkbox');
      expect(checkboxes).toHaveLength(3);

      await act(async () => {
        checkboxes[0].props.onChange({ target: { checked: true } });
        checkboxes[1].props.onChange({ target: { checked: true } });
        checkboxes[2].props.onChange({ target: { checked: true } });
      });

      const textareas = failureRulesCard.findAll((node) => node.type === 'textarea');
      expect(textareas).toHaveLength(2);

      await act(async () => {
        textareas[0].props.onChange({ target: { value: 'gpt-*\nclaude-sonnet-*' } });
        textareas[1].props.onChange({ target: { value: 'rate limit\nquota exceeded' } });
      });

      const numberInput = failureRulesCard.find((node) => (
        node.type === 'input'
        && node.props.type === 'number'
        && node.props.max === 2000
        && node.props.min === 10
      ));
      await act(async () => {
        numberInput.props.onChange({ target: { value: '640' } });
      });

      const saveButtons = failureRulesCard.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
      ));
      expect(saveButtons).toHaveLength(1);
      const [saveButton] = saveButtons;

      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
        disableCrossProtocolFallback: true,
        globalAllowedModels: ['gpt-*', 'claude-sonnet-*'],
        proxyDebugTraceEnabled: true,
        proxyDebugTraceMaxEntries: 640,
        proxyErrorKeywords: ['rate limit', 'quota exceeded'],
        proxyEmptyContentFailEnabled: true,
      });
    } finally {
      root?.unmount();
    }
  });
});
