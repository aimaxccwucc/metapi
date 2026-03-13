import { describe, expect, it } from 'vitest';
import { create } from 'react-test-renderer';
import { MobileCard, MobileField } from './MobileCard.js';

describe('MobileCard', () => {
  it('renders title and fields', () => {
    const root = create(
      <MobileCard title="CardTitle">
        <MobileField label="Status" value="OK" />
      </MobileCard>,
    );

    const text = root.root.findAll(() => true)
      .flatMap((instance) => instance.children)
      .filter((child): child is string => typeof child === 'string')
      .join('');

    expect(text).toContain('CardTitle');
    expect(text).toContain('Status');
    expect(text).toContain('OK');
  });
});
