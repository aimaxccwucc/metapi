import { describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import MobileDrawer from './MobileDrawer.js';

describe('MobileDrawer', () => {
  it('renders content when open and closes on backdrop click', () => {
    const onClose = vi.fn();
    const root = create(
      <MobileDrawer open onClose={onClose}>
        <div>DrawerContent</div>
      </MobileDrawer>,
    );

    const text = root.root.findAll(() => true)
      .flatMap((instance) => instance.children)
      .filter((child): child is string => typeof child === 'string')
      .join('');

    expect(text).toContain('DrawerContent');

    const backdrop = root.root.find((node) => node.props?.className === 'mobile-drawer-backdrop');
    backdrop.props.onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
