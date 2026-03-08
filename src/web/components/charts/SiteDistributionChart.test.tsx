import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import SiteDistributionChart from './SiteDistributionChart.js';

vi.mock('@visactor/react-vchart', () => ({
  VChart: () => null,
}));

describe('SiteDistributionChart', () => {
  const originalDocument = globalThis.document;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalMutationObserver = globalThis.MutationObserver;

  beforeEach(() => {
    globalThis.document = {
      documentElement: {
        getAttribute: vi.fn(),
      },
    } as unknown as Document;
    delete (globalThis as typeof globalThis & { getComputedStyle?: typeof getComputedStyle }).getComputedStyle;
    delete (globalThis as typeof globalThis & { MutationObserver?: typeof MutationObserver }).MutationObserver;
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.MutationObserver = originalMutationObserver;
  });

  it('renders with fallback label color when browser theme APIs are unavailable', async () => {
    let renderer: ReturnType<typeof create> | null = null;

    await expect(act(async () => {
      renderer = create(
        <SiteDistributionChart
          data={[
            {
              siteName: 'Demo Site',
              platform: 'demo',
              totalBalance: 12.34,
              totalSpend: 1.23,
              accountCount: 2,
            },
          ]}
        />,
      );
    })).resolves.toBeUndefined();

    renderer?.unmount();
  });
});
