import { describe, expect, it } from 'vitest';
import { act, create } from 'react-test-renderer';
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

  it('filters searchable options by query', async () => {
    const onChange = () => {};
    const root = create(
      <ModernSelect
        value=""
        onChange={onChange}
        searchable
        searchPlaceholder="搜索站点"
        options={[
          { value: '1', label: 'CCLL', description: 'new-api · https://ccll.example.com' },
          { value: '2', label: 'AxonHub', description: 'one-api · https://axonhub.example.com' },
        ]}
      />,
    );

    await act(async () => {
      root.root.findByProps({ className: 'modern-select-trigger' }).props.onClick();
    });

    const searchInput = root.root.findByProps({ className: 'modern-select-search-input' });
    await act(async () => {
      searchInput.props.onChange({ target: { value: 'axon' } });
    });

    const text = collectText(root.root);
    expect(text).toContain('AxonHub');
    expect(text).not.toContain('CCLL');
  });
});
