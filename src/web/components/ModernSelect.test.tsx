import { describe, expect, it } from 'vitest';
import { create } from 'react-test-renderer';
import ModernSelect from './ModernSelect.js';

function collectText(node: ReturnType<typeof create>['root']): string {
  return node.findAll(() => true)
    .flatMap((instance) => instance.children)
    .filter((child): child is string => typeof child === 'string')
    .join('');
}

describe('ModernSelect', () => {
  it('renders icon nodes for the selected option', () => {
    const root = create(
      <ModernSelect
        value="nvidia"
        onChange={() => {}}
        options={[
          {
            value: 'nvidia',
            label: 'NVIDIA',
            description: 'NVIDIA 品牌图标',
            iconNode: <span>🟢</span>,
          } as any,
        ]}
      />,
    );

    expect(collectText(root.root)).toContain('🟢');
    expect(collectText(root.root)).toContain('NVIDIA');
  });
});
