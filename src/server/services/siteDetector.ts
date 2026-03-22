import { detectPlatform } from './platforms/index.js';

export async function detectSite(url: string) {
  const normalizedUrl = url.replace(/\/+$/, '');
  const originUrl = (() => {
    try {
      return new URL(normalizedUrl).origin;
    } catch {
      return normalizedUrl;
    }
  })();
  const adapter = await detectPlatform(originUrl);
  if (!adapter) return null;
  return { url: originUrl, platform: adapter.platformName };
}
