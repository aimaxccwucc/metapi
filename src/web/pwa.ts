export type DeferredInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Ignore registration failures and keep the app usable as a normal web app.
    });
  });
}

export function isStandaloneDisplayMode(): boolean {
  if (typeof window === 'undefined') return false;
  const displayStandalone = typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches;
  const navigatorStandalone = typeof navigator !== 'undefined'
    && 'standalone' in navigator
    && Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return displayStandalone || navigatorStandalone;
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua);
}
