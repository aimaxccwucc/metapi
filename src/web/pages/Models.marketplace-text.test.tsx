import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Models from './Models.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getModelsMarketplace: vi.fn(),
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

describe('Models marketplace text', () => {
  const originalDocument = globalThis.document;
  const originalMutationObserver = globalThis.MutationObserver;

  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  afterEach(() => {
    vi.clearAllMocks();
    globalThis.document = originalDocument;
    globalThis.MutationObserver = originalMutationObserver;
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
      root?.unmount();
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
      root?.unmount();
    }
  });
});
