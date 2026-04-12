type PulledEventBatch<TEvent> = {
  events: TEvent[];
  rest: string;
};

type ProxyStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

type ProxyStreamLifecycleInput<TEvent> = {
  reader: ProxyStreamReader | null | undefined;
  response: { end(): void };
  pullEvents(buffer: string): PulledEventBatch<TEvent>;
  handleEvent(event: TEvent): Promise<boolean | void> | boolean | void;
  onEof?: () => Promise<void> | void;
};

export type ProxyStreamLifecycleTerminationReason =
  | 'completed'
  | 'stopped_by_handler'
  | 'reader_error'
  | 'eof_with_trailing_buffer';

export type ProxyStreamLifecycleSummary = {
  reason: ProxyStreamLifecycleTerminationReason;
  readerErrorMessage: string | null;
  hadTrailingBuffer: boolean;
  stoppedByHandler: boolean;
};

export function createProxyStreamLifecycle<TEvent>(input: ProxyStreamLifecycleInput<TEvent>) {
  const flushBuffer = async (buffer: string): Promise<{ rest: string; stop: boolean }> => {
    const pulled = input.pullEvents(buffer);
    for (const event of pulled.events) {
      if (await input.handleEvent(event)) {
        return {
          rest: pulled.rest,
          stop: true,
        };
      }
    }

    return {
      rest: pulled.rest,
      stop: false,
    };
  };

  return {
    async run(): Promise<ProxyStreamLifecycleSummary> {
      const reader = input.reader;
      if (!reader) {
        try {
          await input.onEof?.();
        } finally {
          input.response.end();
        }
        return {
          reason: 'completed',
          readerErrorMessage: null,
          hadTrailingBuffer: false,
          stoppedByHandler: false,
        };
      }

      const decoder = new TextDecoder();
      let sseBuffer = '';
      let shouldStop = false;
      let readerErrorMessage: string | null = null;
      let terminationReason: ProxyStreamLifecycleTerminationReason = 'completed';

      try {
        while (true) {
          let readResult: { done: boolean; value?: Uint8Array };
          try {
            readResult = await reader.read();
          } catch (error) {
            readerErrorMessage = error instanceof Error ? error.message : String(error);
            terminationReason = 'reader_error';
            break;
          }
          const { done, value } = readResult;
          if (done) break;
          if (!value) continue;

          sseBuffer += decoder.decode(value, { stream: true });
          const flushed = await flushBuffer(sseBuffer);
          sseBuffer = flushed.rest;
          if (!flushed.stop) continue;

          shouldStop = true;
          terminationReason = 'stopped_by_handler';
          await reader.cancel().catch(() => {});
          break;
        }

        if (!shouldStop && terminationReason !== 'reader_error') {
          sseBuffer += decoder.decode();
          if (sseBuffer.trim().length > 0) {
            const flushed = await flushBuffer(`${sseBuffer}\n\n`);
            sseBuffer = flushed.rest;
            shouldStop = flushed.stop;
            if (flushed.stop) {
              terminationReason = 'stopped_by_handler';
            }
          }
        }

        const hadTrailingBuffer = sseBuffer.trim().length > 0;
        if (!shouldStop && terminationReason !== 'reader_error') {
          if (hadTrailingBuffer) {
            terminationReason = 'eof_with_trailing_buffer';
          }
          await input.onEof?.();
        }
        return {
          reason: terminationReason,
          readerErrorMessage,
          hadTrailingBuffer,
          stoppedByHandler: shouldStop,
        };
      } finally {
        reader.releaseLock();
        input.response.end();
      }
    },
  };
}
