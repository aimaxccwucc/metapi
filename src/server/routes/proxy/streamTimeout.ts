import { config } from '../../config.js';

type ReaderReadResult<T> = {
  done: boolean;
  value?: T;
};

type ReaderLike<T> = {
  read: () => Promise<ReaderReadResult<T>>;
  cancel?: (reason?: unknown) => Promise<unknown> | unknown;
  releaseLock?: () => void;
};

type StrictReaderLike<T> = {
  read: () => Promise<ReaderReadResult<T>>;
  cancel: (reason?: unknown) => Promise<unknown>;
  releaseLock: () => void;
};

export function wrapReaderWithIdleTimeout<T>(
  reader: ReaderLike<T>,
  timeoutMs = config.upstreamStreamIdleTimeoutMs,
): StrictReaderLike<T> {
  const normalizedTimeoutMs = Math.max(1_000, timeoutMs);
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let activeReject: ((reason: unknown) => void) | undefined;

  function clearActiveTimer(): void {
    if (activeTimer !== undefined) {
      clearTimeout(activeTimer);
      activeTimer = undefined;
      activeReject = undefined;
    }
  }

  return {
    async read() {
      clearActiveTimer();
      return await Promise.race([
        reader.read(),
        new Promise<ReaderReadResult<T>>((_, reject) => {
          activeReject = reject;
          activeTimer = setTimeout(() => {
            activeReject = undefined;
            activeTimer = undefined;
            reject(new Error(`upstream stream idle timeout after ${normalizedTimeoutMs}ms`));
          }, normalizedTimeoutMs);
        }),
      ]).finally(() => {
        clearActiveTimer();
      });
    },
    cancel(reason?: unknown) {
      clearActiveTimer();
      return Promise.resolve(reader.cancel?.(reason));
    },
    releaseLock() {
      clearActiveTimer();
      reader.releaseLock?.();
    },
  };
}
