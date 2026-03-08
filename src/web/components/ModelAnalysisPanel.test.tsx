import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import ModelAnalysisPanel from './ModelAnalysisPanel.js';

vi.mock('@visactor/react-vchart', () => ({
  VChart: () => <div>mock-chart</div>,
}));

vi.mock('./BrandIcon.js', () => ({
  InlineBrandIcon: () => <span>brand-icon</span>,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

describe('ModelAnalysisPanel token summaries', () => {
  const originalDocument = globalThis.document;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalMutationObserver = globalThis.MutationObserver;

  beforeEach(() => {
    globalThis.document = {
      documentElement: {},
    } as unknown as Document;
    globalThis.getComputedStyle = vi.fn(() => ({
      getPropertyValue: () => '#9ca3af',
    })) as unknown as typeof getComputedStyle;
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof MutationObserver;
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.MutationObserver = originalMutationObserver;
  });

  it('renders total token summaries with compact units', () => {
    let root: ReturnType<typeof create> | null = null;

    act(() => {
      root = create(
        <ModelAnalysisPanel
          data={{
            totals: {
              spend: 0.123456,
              calls: 10,
              tokens: 611_540_335,
            },
          }}
        />,
      );
    });

    const rendered = collectText(root!.root);

    expect(rendered).toContain('总 Tokens');
    expect(rendered).toContain('611.5M');

    root?.unmount();
  });

  it('renders with fallback label color when browser theme APIs are unavailable', async () => {
    globalThis.document = {
      documentElement: {},
    } as unknown as Document;
    delete (globalThis as typeof globalThis & { getComputedStyle?: typeof getComputedStyle }).getComputedStyle;
    delete (globalThis as typeof globalThis & { MutationObserver?: typeof MutationObserver }).MutationObserver;

    let root: ReturnType<typeof create> | null = null;

    await expect(act(async () => {
      root = create(
        <ModelAnalysisPanel
          data={{
            totals: {
              spend: 0.123456,
              calls: 10,
              tokens: 611_540_335,
            },
          }}
        />,
      );
    })).resolves.toBeUndefined();

    root?.unmount();
  });
});
