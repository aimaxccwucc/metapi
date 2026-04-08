import { describe, expect, it } from 'vitest';
import {
  extractEntryAssetPathFromHtml,
  findCurrentEntryAssetPath,
  normalizeEntryAssetPath,
  shouldAutoReloadForVersionMismatch,
} from './appVersion.js';

describe('appVersion helpers', () => {
  it('normalizes hashed entry asset paths from absolute and relative urls', () => {
    expect(normalizeEntryAssetPath('/assets/index-ABC123.js', 'https://metapi.test/accounts'))
      .toBe('/assets/index-ABC123.js');
    expect(normalizeEntryAssetPath('https://metapi.test/assets/index-XYZ789.js', 'https://metapi.test/accounts'))
      .toBe('/assets/index-XYZ789.js');
    expect(normalizeEntryAssetPath('/assets/chunk-other.js', 'https://metapi.test/accounts'))
      .toBeNull();
  });

  it('extracts the latest entry asset path from html', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <script type="module" src="/assets/index-CV7VKH45.js"></script>
        </head>
      </html>
    `;

    expect(extractEntryAssetPathFromHtml(html, 'https://metapi.test/accounts'))
      .toBe('/assets/index-CV7VKH45.js');
  });

  it('finds the current entry asset path from the document scripts', () => {
    const doc = {
      baseURI: 'https://metapi.test/accounts',
      querySelectorAll: () => [
        {
          getAttribute: (name: string) => (name === 'src' ? '/assets/index-CV7VKH45.js' : null),
          src: 'https://metapi.test/assets/index-CV7VKH45.js',
        },
      ],
    } as unknown as Document;

    expect(findCurrentEntryAssetPath(doc)).toBe('/assets/index-CV7VKH45.js');
  });

  it('only auto reloads once for the same newer bundle', () => {
    expect(shouldAutoReloadForVersionMismatch('/assets/index-old.js', '/assets/index-new.js', null)).toBe(true);
    expect(shouldAutoReloadForVersionMismatch('/assets/index-old.js', '/assets/index-new.js', '/assets/index-new.js')).toBe(false);
    expect(shouldAutoReloadForVersionMismatch('/assets/index-new.js', '/assets/index-new.js', null)).toBe(false);
  });
});
