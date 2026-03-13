import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Sites centered modal adoption', () => {
  it('uses CenteredModal for add/edit site flows instead of inline form panels', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Sites.tsx'), 'utf8');

    expect(source).toContain("import CenteredModal from '../components/CenteredModal.js'");
    expect(source).toContain('<CenteredModal');
    expect(source).not.toContain('editorPresence.shouldRender && activeEditor && (');
  });
});
