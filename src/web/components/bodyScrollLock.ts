let bodyScrollLockCount = 0;
let bodyScrollLockPreviousOverflow: string | null = null;

function canUseDocument(): boolean {
  return typeof document !== 'undefined' && !!document.body?.style;
}

export function acquireBodyScrollLock(): () => void {
  if (!canUseDocument()) return () => {};

  if (bodyScrollLockCount === 0) {
    bodyScrollLockPreviousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  bodyScrollLockCount += 1;
  let released = false;

  return () => {
    if (released || !canUseDocument()) return;
    released = true;
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount === 0) {
      document.body.style.overflow = bodyScrollLockPreviousOverflow ?? '';
      bodyScrollLockPreviousOverflow = null;
    }
  };
}

export function __resetBodyScrollLockForTest() {
  bodyScrollLockCount = 0;
  bodyScrollLockPreviousOverflow = null;
}
