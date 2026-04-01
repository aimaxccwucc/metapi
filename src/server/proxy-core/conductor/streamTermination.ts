export function terminalStreamFailure(input: {
  status?: number;
  rawErrorText?: string;
  retryAfterHeader?: string | null;
  retryAfterMs?: number | null;
}) {
  return {
    action: 'terminal' as const,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.rawErrorText ? { rawErrorText: input.rawErrorText } : {}),
    ...(input.retryAfterHeader !== undefined ? { retryAfterHeader: input.retryAfterHeader } : {}),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
  };
}
