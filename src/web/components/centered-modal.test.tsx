import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('CenteredModal component', () => {
  it('uses the shared centered modal shell pattern', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/components/CenteredModal.tsx'), 'utf8');

    expect(source).toContain('modal-backdrop');
    expect(source).toContain('modal-content');
    expect(source).toContain('useAnimatedVisibility');
    expect(source).toContain('createPortal');
  });
});
