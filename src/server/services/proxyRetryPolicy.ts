const MODEL_UNSUPPORTED_PATTERNS: RegExp[] = [
  /当前\s*api\s*不支持所选模型/i,
  /不支持所选模型/i,
  /不支持.*模型/i,
  /模型.*不支持/i,
  /unsupported\s+model/i,
  /model\s+not\s+supported/i,
  /does\s+not\s+support(?:\s+the)?\s+model/i,
  /model.*does\s+not\s+exist/i,
  /no\s+such\s+model/i,
  /unknown\s+model/i,
  /invalid\s+model/i,
  /model[_\s-]?not[_\s-]?found/i,
  /you\s+do\s+not\s+have\s+access\s+to\s+the\s+model/i,
];

export type RetryFailureCategory =
  | 'network'
  | 'server'
  | 'rate_limit'
  | 'payload_too_large'
  | 'model_unsupported'
  | 'auth'
  | 'bad_request'
  | 'unknown';

export type ProxyFailureContext = {
  status?: number | null;
  upstreamErrorText?: string | null;
};

function isModelUnsupportedErrorMessage(rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return MODEL_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyProxyFailure(context: ProxyFailureContext): RetryFailureCategory {
  const status = Number.isFinite(context.status) ? Number(context.status) : 0;
  const errorText = (context.upstreamErrorText || '').trim();

  if (!status || status < 0) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (isModelUnsupportedErrorMessage(errorText)) return 'model_unsupported';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

export function shouldRetryProxyRequest(status: number, upstreamErrorText?: string | null): boolean {
  const category = classifyProxyFailure({ status, upstreamErrorText });
  return category !== 'auth' && category !== 'bad_request' && category !== 'unknown';
}
