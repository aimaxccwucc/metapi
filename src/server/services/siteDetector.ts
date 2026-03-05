import { detectPlatform } from './platforms/index.js';

function normalizeDetectBaseUrl(url: string): string {
  const trimmed = (url || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export async function detectSite(url: string) {
  const normalizedUrl = (url || '').trim().replace(/\/+$/, '');
  if (!normalizedUrl) return null;

  // Platform probes should target site root to avoid path-specific 404/challenge pages.
  const detectBaseUrl = normalizeDetectBaseUrl(normalizedUrl) || normalizedUrl;
  const adapter = await detectPlatform(detectBaseUrl);
  if (!adapter) return null;
  return { url: normalizedUrl, platform: adapter.platformName };
}
