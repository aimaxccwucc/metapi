export const APP_VERSION_RELOAD_STORAGE_KEY = 'metapi.appVersion.reloadTarget';

const ENTRY_ASSET_PATH_PATTERN = /\/assets\/index-[^/?#"'<>]+\.js$/i;
const HTML_ASSET_ATTRIBUTE_PATTERN = /\b(?:src|href)=["']([^"']+)["']/gi;

export function normalizeEntryAssetPath(candidate: string, baseUrl: string): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate, baseUrl);
    return ENTRY_ASSET_PATH_PATTERN.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

export function extractEntryAssetPathFromHtml(html: string, baseUrl: string): string | null {
  if (!html) return null;
  let match: RegExpExecArray | null = null;
  while ((match = HTML_ASSET_ATTRIBUTE_PATTERN.exec(html)) !== null) {
    const normalized = normalizeEntryAssetPath(match[1] || '', baseUrl);
    if (normalized) return normalized;
  }
  return null;
}

export function findCurrentEntryAssetPath(
  doc: Pick<Document, 'baseURI' | 'querySelectorAll'>,
): string | null {
  const scripts = Array.from(doc.querySelectorAll('script[src]'));
  for (const node of scripts) {
    const script = node as HTMLScriptElement;
    const candidate = script.getAttribute('src') || script.src || '';
    const normalized = normalizeEntryAssetPath(candidate, doc.baseURI || 'http://localhost/');
    if (normalized) return normalized;
  }
  return null;
}

export function shouldAutoReloadForVersionMismatch(
  currentEntryAssetPath: string | null,
  latestEntryAssetPath: string | null,
  lastReloadTarget: string | null,
): boolean {
  if (!currentEntryAssetPath || !latestEntryAssetPath) return false;
  if (currentEntryAssetPath === latestEntryAssetPath) return false;
  return lastReloadTarget !== latestEntryAssetPath;
}
