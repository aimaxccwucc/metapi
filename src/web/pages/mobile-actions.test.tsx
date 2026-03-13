import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Mobile actions bar styles', () => {
  it('defines .mobile-actions-bar in index.css', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');
    expect(css).toContain('.mobile-actions-bar');
  });
});
