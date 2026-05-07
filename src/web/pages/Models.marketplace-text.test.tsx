import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Models from './Models.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getModelsMarketplace: vi.fn(),
    testMarketplaceModelAvailability: vi.fn(),
    getAccountTokenValue: vi.fn(),
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

async function unmountRoot(root: ReturnType<typeof create> | null) {
  if (!root) return;
  await act(async () => {
    root.unmount();
  });
}

describe('Models marketplace text', () => {
  const originalDocument = globalThis.document;
  const originalMutationObserver = globalThis.MutationObserver;
  const originalWindow = globalThis.window;
  const originalMatchMedia = globalThis.matchMedia;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(globalThis.navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    globalThis.document = {
      documentElement: {
        getAttribute: () => 'light',
      },
    } as unknown as Document;
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof MutationObserver;
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gpt-4o',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 320,
          successRate: 98,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: 'Demo Site',
              username: 'tester',
              latency: 320,
              balance: 12.5,
              tokens: [{ id: 1, name: 'default', isDefault: true }],
            },
          ],
        },
      ],
    });
    apiMock.testMarketplaceModelAvailability.mockResolvedValue({
      available: true,
      reason: 'model found in upstream list',
      latencyMs: 123,
      autoKeyCreated: false,
    });
    apiMock.getAccountTokenValue.mockResolvedValue({
      success: true,
      token: 'sk-autocreated-demo',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    globalThis.document = originalDocument;
    globalThis.MutationObserver = originalMutationObserver;
    globalThis.window = originalWindow;
    globalThis.matchMedia = originalMatchMedia;
  });

  it('renders readable Chinese labels and fallback descriptions for marketplace models', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const initialText = collectText(root!.root);
      expect(initialText).toContain('品牌');
      expect(initialText).toContain('排序方式');
      expect(initialText).toContain('模型广场');

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card')
        && typeof node.props.onClick === 'function'
      ));
      expect(cards.length).toBeGreaterThan(0);

      await act(async () => {
        cards[0]!.props.onClick();
      });
      await flushMicrotasks();

      const expandedText = collectText(root!.root);
      expect(expandedText).toContain('当前上游仅返回模型 ID，未返回描述字段。');
      expect(expandedText).toContain('基础信息');
      expect(expandedText).toContain('站点');
      expect(expandedText).toContain('余额');
    } finally {
      await unmountRoot(root);
    }
  });

  it('shows newly recognized brands in the marketplace filter panel', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'nvidia/vila',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 210,
          successRate: 97,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: '公益站 A',
              username: 'tester',
              latency: 210,
              balance: 6.5,
              tokens: [{ id: 1, name: 'default', isDefault: true }],
            },
          ],
        },
        {
          name: 'deepl-zh-en',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 160,
          successRate: 99,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 2,
              site: '公益站 B',
              username: 'tester',
              latency: 160,
              balance: 8.8,
              tokens: [{ id: 2, name: 'default', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root!.root);
      expect(text).toContain('NVIDIA');
      expect(text).toContain('DeepL');
      expect(text).not.toContain('其他未归类的模型');
    } finally {
      await unmountRoot(root);
    }
  });

  it('splits copied token and diagnostic actions after auto key creation', async () => {
    apiMock.testMarketplaceModelAvailability.mockResolvedValue({
      available: true,
      reason: 'model found in upstream list',
      latencyMs: 123,
      autoKeyCreated: true,
      autoKeyTokenId: 9,
      autoKeyName: 'auto-demo',
      autoKeyGroup: 'default',
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card')
        && typeof node.props.onClick === 'function'
      ));
      await act(async () => {
        cards[0]!.props.onClick();
      });
      await flushMicrotasks();

      const detectButton = root!.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('检测')
      ));
      await act(async () => {
        await detectButton.props.onClick();
      });
      await flushMicrotasks();

      expect(collectText(root!.root)).toContain('复制 Key');
      expect(collectText(root!.root)).toContain('复制诊断摘要');
    } finally {
      await unmountRoot(root);
    }
  });

  it('keeps a visible mobile filter entry on small screens', async () => {
    const nextWindow = (originalWindow ? { ...originalWindow } : {}) as Window & typeof globalThis;
    nextWindow.innerWidth = 768;
    nextWindow.addEventListener = nextWindow.addEventListener || (() => {});
    nextWindow.removeEventListener = nextWindow.removeEventListener || (() => {});
    nextWindow.matchMedia = (() => ({
      matches: true,
      media: '(max-width: 768px)',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    globalThis.window = nextWindow;
    globalThis.matchMedia = nextWindow.matchMedia;

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(collectText(root!.root)).toContain('筛选');
    } finally {
      await unmountRoot(root);
    }
  });

  it('keeps the mobile filter entry visible even while the first screen is still loading', async () => {
    globalThis.window = {
      innerWidth: 768,
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: (() => ({
        matches: true,
        media: '(max-width: 768px)',
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia,
    } as unknown as Window & typeof globalThis;
    globalThis.matchMedia = globalThis.window.matchMedia;
    apiMock.getModelsMarketplace.mockImplementation(() => new Promise(() => {}));

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });

      expect(collectText(root!.root)).toContain('筛选');
    } finally {
      await unmountRoot(root);
    }
  });

  it('limits expanded account and pricing detail to the selected site filter', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gpt-4o',
          accountCount: 2,
          tokenCount: 3,
          avgLatency: 500,
          successRate: 96,
          description: 'demo model',
          tags: ['chat'],
          supportedEndpointTypes: ['openai'],
          pricingSources: [
            {
              siteId: 1,
              siteName: '站点 A',
              accountId: 1,
              username: 'user-a',
              ownerBy: null,
              enableGroups: [],
              groupRatio: { default: 0.5 },
              groupPricing: {
                default: {
                  quotaType: 0,
                  inputPerMillion: 1,
                  outputPerMillion: 2,
                },
              },
            },
            {
              siteId: 2,
              siteName: '站点 B',
              accountId: 2,
              username: 'user-b',
              ownerBy: null,
              enableGroups: [],
              groupRatio: { default: 3 },
              groupPricing: {
                default: {
                  quotaType: 0,
                  inputPerMillion: 3,
                  outputPerMillion: 4,
                },
              },
            },
          ],
          accounts: [
            {
              id: 1,
              site: '站点 A',
              username: 'user-a',
              latency: 320,
              balance: 12.5,
              tokens: [
                { id: 1, name: 'token-a-1', isDefault: true },
                { id: 2, name: 'token-a-2', isDefault: false },
              ],
            },
            {
              id: 2,
              site: '站点 B',
              username: 'user-b',
              latency: 680,
              balance: 8.4,
              tokens: [
                { id: 3, name: 'token-b-1', isDefault: true },
              ],
            },
          ],
        },
      ],
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const siteFilterItem = root!.root.find((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('filter-item')
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('站点 A')
      ));

      await act(async () => {
        siteFilterItem.props.onClick();
      });
      await flushMicrotasks();

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card')
        && typeof node.props.onClick === 'function'
      ));
      expect(cards.length).toBeGreaterThan(0);

      await act(async () => {
        cards[0]!.props.onClick();
      });
      await flushMicrotasks();

      const expandedSections = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card-expand')
      ));
      expect(expandedSections.length).toBe(1);

      const expandedText = collectText(expandedSections[0]!);
      expect(expandedText).toContain('站点 A');
      expect(expandedText).toContain('user-a');
      expect(expandedText).toContain('token-a-1');
      expect(expandedText).toContain('0.5x');
      expect(expandedText).not.toContain('站点 B');
      expect(expandedText).not.toContain('user-b');
      expect(expandedText).not.toContain('token-b-1');
      expect(expandedText).not.toContain('3x');
    } finally {
      await unmountRoot(root);
    }
  });

  it('re-sorts models using site-scoped counts after selecting a site filter', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gpt-4o',
          accountCount: 4,
          tokenCount: 4,
          avgLatency: 300,
          successRate: 98,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: '站点 A',
              username: 'user-a-1',
              latency: 300,
              balance: 8,
              tokens: [{ id: 1, name: 'token-a-1', isDefault: true }],
            },
            {
              id: 2,
              site: '站点 B',
              username: 'user-b-1',
              latency: 200,
              balance: 8,
              tokens: [{ id: 2, name: 'token-b-1', isDefault: true }],
            },
            {
              id: 3,
              site: '站点 B',
              username: 'user-b-2',
              latency: 250,
              balance: 8,
              tokens: [{ id: 3, name: 'token-b-2', isDefault: true }],
            },
            {
              id: 4,
              site: '站点 B',
              username: 'user-b-3',
              latency: 260,
              balance: 8,
              tokens: [{ id: 4, name: 'token-b-3', isDefault: true }],
            },
          ],
        },
        {
          name: 'claude-3-5-sonnet',
          accountCount: 2,
          tokenCount: 2,
          avgLatency: 420,
          successRate: 95,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 5,
              site: '站点 A',
              username: 'user-a-2',
              latency: 410,
              balance: 9,
              tokens: [{ id: 5, name: 'token-a-2', isDefault: true }],
            },
            {
              id: 6,
              site: '站点 A',
              username: 'user-a-3',
              latency: 430,
              balance: 9,
              tokens: [{ id: 6, name: 'token-a-3', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const siteFilterItem = root!.root.find((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('filter-item')
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('站点 A')
      ));

      await act(async () => {
        siteFilterItem.props.onClick();
      });
      await flushMicrotasks();

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.split(' ').includes('model-card')
        && typeof node.props.onClick === 'function'
      ));

      expect(cards.length).toBe(2);
      expect(collectText(cards[0]!)).toContain('claude-3-5-sonnet');
      expect(collectText(cards[1]!)).toContain('gpt-4o');
    } finally {
      await unmountRoot(root);
    }
  });

  it('renders unknown latency instead of falling back to another site latency', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gpt-4o',
          accountCount: 2,
          tokenCount: 2,
          avgLatency: 680,
          successRate: 93,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: '站点 A',
              username: 'user-a',
              latency: null,
              balance: 12,
              tokens: [{ id: 1, name: 'token-a', isDefault: true }],
            },
            {
              id: 2,
              site: '站点 B',
              username: 'user-b',
              latency: 680,
              balance: 12,
              tokens: [{ id: 2, name: 'token-b', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const siteFilterItem = root!.root.find((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('filter-item')
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('站点 A')
      ));

      await act(async () => {
        siteFilterItem.props.onClick();
      });
      await flushMicrotasks();

      const latencyBadge = root!.root.find((node) => (
        node.type === 'span'
        && node.props['data-tooltip'] === '平均延迟'
      ));

      expect(String(latencyBadge.props.className || '')).toContain('badge-muted');
      expect(collectText(latencyBadge)).toContain('延迟');
      expect(collectText(latencyBadge)).toContain('—');
      expect(collectText(root!.root)).not.toContain('680ms');
    } finally {
      await unmountRoot(root);
    }
  });

  it('runs marketplace availability checks from expanded account details', async () => {
    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card')
        && typeof node.props.onClick === 'function'
      ));
      expect(cards.length).toBeGreaterThan(0);

      await act(async () => {
        cards[0]!.props.onClick();
      });
      await flushMicrotasks();

      const checkButtons = root!.root.findAll((node) => (
        node.type === 'button'
        && collectText(node).includes('检测')
      ));
      expect(checkButtons.length).toBeGreaterThan(0);

      await act(async () => {
        await checkButtons[0]!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.testMarketplaceModelAvailability).toHaveBeenCalledWith({
        modelName: 'gpt-4o',
        accountId: 1,
        siteName: 'Demo Site',
      });
      expect(collectText(root!.root)).toContain('可用 123ms');
    } finally {
      await unmountRoot(root);
    }
  });


  it('shows inconclusive marketplace probes as 未确认 instead of 不可用', async () => {
    apiMock.testMarketplaceModelAvailability.mockResolvedValue({
      available: false,
      reason: '模型已在列表中，实时探测未得出确定结论（chat）：chat:200 empty content',
      probeClassification: 'inconclusive',
      detectionMethod: 'realtime_probe',
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card')
        && typeof node.props.onClick === 'function'
      ));
      expect(cards.length).toBeGreaterThan(0);

      await act(async () => {
        cards[0]!.props.onClick();
      });
      await flushMicrotasks();

      const checkButtons = root!.root.findAll((node) => (
        node.type === 'button'
        && collectText(node).includes('检测')
      ));
      expect(checkButtons.length).toBeGreaterThan(0);

      await act(async () => {
        await checkButtons[0]!.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root!.root);
      expect(text).toContain('未确认');
      expect(text).toContain('chat:200 empty content');
    } finally {
      await unmountRoot(root);
    }
  });

  it('keeps diagnosis actions aligned across card and table detail views after auto key creation', async () => {
    apiMock.testMarketplaceModelAvailability.mockResolvedValue({
      available: true,
      reason: '实时探测成功',
      latencyMs: 88,
      autoKeyCreated: true,
      autoKeyName: 'mk-gpt-4o',
      autoKeyGroup: 'vip',
      autoKeyTokenId: 99,
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card')
        && typeof node.props.onClick === 'function'
      ));
      expect(cards.length).toBeGreaterThan(0);

      await act(async () => {
        cards[0]!.props.onClick();
      });
      await flushMicrotasks();

      const cardCheckButton = root!.root.find((node) => (
        node.type === 'button'
        && collectText(node) === '检测'
      ));
      await act(async () => {
        await cardCheckButton.props.onClick();
      });
      await flushMicrotasks();

      const cardText = collectText(root!.root);
      expect(cardText).toContain('已自动补 Key');
      expect(cardText).toContain('自动补 Key: vip / mk-gpt-4o');
      expect(cardText).toContain('前往账号令牌管理');
      expect(cardText).toContain('复制 Key');
      expect(cardText).toContain('复制诊断摘要');

      const cardCopyButton = root!.root.find((node) => (
        node.type === 'button'
        && collectText(node).includes('复制 Key')
      ));
      await act(async () => {
        await cardCopyButton.props.onClick();
      });
      await flushMicrotasks();
      expect(apiMock.getAccountTokenValue).toHaveBeenCalledWith(99);
      expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith('sk-autocreated-demo');

      const tableToggle = root!.root.find((node) => (
        node.type === 'button'
        && node.props['aria-label'] === '表格视图'
      ));
      await act(async () => {
        tableToggle.props.onClick();
      });
      await flushMicrotasks();

      const tableText = collectText(root!.root);
      expect(tableText).toContain('可用性检测');
      expect(tableText).toContain('前往账号令牌管理');
      expect(tableText).toContain('$12.50');
      expect(tableText.includes('复制 Key') || tableText.includes('已复制')).toBe(true);
    } finally {
      await unmountRoot(root);
    }
  });

  it('supports sorting by balance from the table header', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gpt-low',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 200,
          successRate: 99,
          balance: 0,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: 'Site A',
              username: 'alice',
              latency: 200,
              balance: 3,
              tokens: [{ id: 1, name: 'default', isDefault: true }],
            },
          ],
        },
        {
          name: 'gpt-high',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 200,
          successRate: 99,
          balance: 0,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 2,
              site: 'Site B',
              username: 'bob',
              latency: 200,
              balance: 15,
              tokens: [{ id: 2, name: 'default', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const tableToggle = root!.root.find((node) => (
        node.type === 'button'
        && node.props['aria-label'] === '表格视图'
      ));

      await act(async () => {
        tableToggle.props.onClick();
      });
      await flushMicrotasks();

      const balanceHeader = root!.root.find((node) => (
        node.type === 'th'
        && collectText(node).includes('余额')
        && typeof node.props.onClick === 'function'
      ));

      await act(async () => {
        balanceHeader.props.onClick();
      });
      await flushMicrotasks();

      const codeNodes = root!.root.findAll((node) => node.type === 'code');
      expect(collectText(codeNodes[0]!)).toContain('gpt-high');
      expect(collectText(root!.root)).toContain('$15.00');
      expect(collectText(root!.root)).toContain('$3.00');
    } finally {
      await unmountRoot(root);
    }
  });

  it('shows per-site pricing and sorts by the lowest site-specific price', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'expensive-model',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 200,
          successRate: 99,
          balance: 0,
          description: 'priced',
          tags: ['chat'],
          supportedEndpointTypes: ['openai'],
          pricingSources: [
            {
              siteId: 1,
              siteName: 'expensive-site',
              accountId: 1,
              username: 'expensive-user',
              ownerBy: null,
              enableGroups: ['default'],
              groupRatio: { default: 4 },
              groupPricing: {
                default: {
                  quotaType: 0,
                  inputPerMillion: 8,
                  outputPerMillion: 12,
                },
              },
            },
          ],
          accounts: [
            {
              id: 1,
              site: 'expensive-site',
              username: 'expensive-user',
              latency: 200,
              balance: 3,
              tokens: [{ id: 1, name: 'default', isDefault: true }],
            },
          ],
        },
        {
          name: 'cheap-model',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 200,
          successRate: 99,
          balance: 0,
          description: 'priced',
          tags: ['chat'],
          supportedEndpointTypes: ['openai'],
          pricingSources: [
            {
              siteId: 2,
              siteName: 'cheap-site',
              accountId: 2,
              username: 'cheap-user',
              ownerBy: null,
              enableGroups: ['default', 'vip'],
              groupRatio: { default: 1, vip: 0.25 },
              groupPricing: {
                default: {
                  quotaType: 0,
                  inputPerMillion: 2,
                  outputPerMillion: 3,
                },
                vip: {
                  quotaType: 0,
                  inputPerMillion: 0.5,
                  outputPerMillion: 0.75,
                },
              },
            },
          ],
          accounts: [
            {
              id: 2,
              site: 'cheap-site',
              username: 'cheap-user',
              latency: 200,
              balance: 15,
              tokens: [{ id: 2, name: 'default', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const tableToggle = root!.root.find((node) => (
        node.type === 'button'
        && node.props['aria-label'] === '表格视图'
      ));

      await act(async () => {
        tableToggle.props.onClick();
      });
      await flushMicrotasks();

      const priceHeader = root!.root.find((node) => (
        node.type === 'th'
        && collectText(node).includes('价格')
        && typeof node.props.onClick === 'function'
      ));

      await act(async () => {
        priceHeader.props.onClick();
      });
      await flushMicrotasks();

      const codeNodes = root!.root.findAll((node) => node.type === 'code');
      expect(collectText(codeNodes[0]!)).toContain('cheap-model');
      expect(collectText(root!.root)).toContain('$1.2500 / 1M');
      expect(collectText(root!.root)).toContain('$20.0000 / 1M');

      await act(async () => {
        codeNodes[0]!.parent?.parent?.props.onClick();
      });
      await flushMicrotasks();

      const tableText = collectText(root!.root);
      expect(tableText).toContain('cheap-site');
      expect(tableText).toContain('最低参考价');
      expect(tableText).toContain('vip');
      expect(tableText).toContain('0.25x');
      expect(tableText).toContain('0.5/0.75 USD / 1M');
      expect(tableText).toContain('default');
      expect(tableText).toContain('1x');
      expect(tableText).toContain('2/3 USD / 1M');
      expect(tableText).toContain('排序值 $1.2500 / 1M');
    } finally {
      await unmountRoot(root);
    }
  });


  it('sorts expanded card details by latency and balance', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gemini-2.5-pro',
          accountCount: 2,
          tokenCount: 2,
          avgLatency: 300,
          successRate: 95,
          balance: 0,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: 'Site Slow',
              username: 'slow-user',
              latency: 802,
              balance: 56.3,
              tokens: [{ id: 1, name: 'cc', isDefault: true }],
            },
            {
              id: 2,
              site: 'Site Fast',
              username: 'fast-user',
              latency: 257,
              balance: 1.55,
              tokens: [{ id: 2, name: 'cc', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const tableToggle = root!.root.find((node) => (
        node.type === 'button'
        && node.props['aria-label'] === '表格视图'
      ));
      await act(async () => {
        tableToggle.props.onClick();
      });
      await flushMicrotasks();

      const modelRow = root!.root.find((node) => (
        node.type === 'tr'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('gemini-2.5-pro')
      ));
      await act(async () => {
        modelRow.props.onClick();
      });
      await flushMicrotasks();

      const latencyHeader = root!.root.find((node) => node.props['data-testid'] === 'model-card-detail-sort-latency');
      await act(async () => {
        latencyHeader.props.onClick({ preventDefault() {}, stopPropagation() {} });
      });
      await flushMicrotasks();

      let detailRows = root!.root.findAll((node) => (
        node.type === 'tr'
        && collectText(node).includes('slow-user') || collectText(node).includes('fast-user')
      ));
      expect(collectText(detailRows[0]!)).toContain('slow-user');

      const balanceHeader = root!.root.find((node) => node.props['data-testid'] === 'model-card-detail-sort-balance');
      await act(async () => {
        balanceHeader.props.onClick({ preventDefault() {}, stopPropagation() {} });
      });
      await flushMicrotasks();

      detailRows = root!.root.findAll((node) => (
        node.type === 'tr'
        && (collectText(node).includes('slow-user') || collectText(node).includes('fast-user'))
      ));
      expect(collectText(detailRows[0]!)).toContain('slow-user');

    } finally {
      await unmountRoot(root);
    }
  });

  it('summarizes protocol mismatch and credential errors into concise Chinese tips', async () => {
    apiMock.testMarketplaceModelAvailability
      .mockResolvedValueOnce({
        available: false,
        reason: '该站点可能使用了不同的请求协议（gemini-native）：probe rejected model via gemini-native: x-goog-api-key is required',
        probeClassification: 'protocol_mismatch',
        probeEndpoint: 'gemini-native',
      })
      .mockResolvedValueOnce({
        available: false,
        reason: '当前凭证无权访问该模型（chat）：probe rejected model via chat: This token has no access to model',
        probeClassification: 'credential',
        probeEndpoint: 'chat',
      });

    let root: ReturnType<typeof create> | null = null;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card')
        && typeof node.props.onClick === 'function'
      ));
      await act(async () => {
        cards[0]!.props.onClick();
      });
      await flushMicrotasks();

      const checkButtons = root!.root.findAll((node) => (
        node.type === 'button'
        && collectText(node).includes('检测')
      ));

      await act(async () => {
        await checkButtons[0]!.props.onClick();
      });
      await flushMicrotasks();
      expect(collectText(root!.root)).toContain('该站点可能需要不同的请求方式（Gemini 原生协议）');

      const detailToggle = root!.root.find((node) => (
        node.type === 'button'
        && collectText(node).includes('查看详情')
      ));
      await act(async () => {
        detailToggle.props.onClick();
      });
      await flushMicrotasks();
      expect(collectText(root!.root)).toContain('探测结果：请求协议可能不匹配');
      expect(collectText(root!.root)).toContain('探测方式：Gemini 原生协议');
      expect(collectText(root!.root)).toContain('建议动作：检查该站点是否应使用 Gemini 原生协议');

      const copyButton = root!.root.find((node) => (
        node.type === 'button'
        && collectText(node).includes('复制诊断摘要')
      ));
      await act(async () => {
        await copyButton.props.onClick();
      });
      await flushMicrotasks();
      expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalled();

      await act(async () => {
        await checkButtons[0]!.props.onClick();
      });
      await flushMicrotasks();
      expect(collectText(root!.root)).toContain('当前凭证无权访问该模型（OpenAI Chat）');
    } finally {
      await unmountRoot(root);
    }
  });

});
