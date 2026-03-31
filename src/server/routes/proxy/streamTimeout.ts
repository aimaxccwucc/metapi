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
  return {
    async read() {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      return await Promise.race([
        reader.read(),
        new Promise<ReaderReadResult<T>>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`upstream stream idle timeout after ${normalizedTimeoutMs}ms`));
          }, normalizedTimeoutMs);
        }),
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
    },
    cancel(reason?: unknown) {
      return Promise.resolve(reader.cancel?.(reason));
    },
    releaseLock() {
      reader.releaseLock?.();
    },
  };
}
