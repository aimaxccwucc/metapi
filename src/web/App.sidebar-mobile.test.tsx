import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('App mobile sidebar', () => {
  it('renders hamburger trigger for mobile navigation', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');

    expect(source).toContain('aria-label="Open navigation"');
    expect(source).toContain('MobileDrawer');
    expect(source).toContain('mobile-nav');
  });
});
