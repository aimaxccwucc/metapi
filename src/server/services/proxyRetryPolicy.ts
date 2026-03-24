export type RetryFailureCategory =
  | 'network'
  | 'server'
  | 'rate_limit'
  | 'payload_too_large'
  | 'model_unsupported'
  | 'auth'
  | 'bad_request'
  | 'other';

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

const RETRYABLE_CHANNEL_LOCAL_PATTERNS: RegExp[] = [
  /unsupported\s+legacy\s+protocol/i,
  /please\s+use\s+\/v1\/responses/i,
  /please\s+use\s+\/v1\/messages/i,
  /please\s+use\s+\/v1\/chat\/completions/i,
  /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i,
  /unsupported\s+endpoint/i,
  /unsupported\s+path/i,
  /unknown\s+endpoint/i,
  /unrecognized\s+request\s+url/i,
  /no\s+route\s+matched/i,
  /invalid\s+api\s+key/i,
  /invalid\s+access\s+token/i,
  /forbidden/i,
  /rate\s+limit/i,
  /quota/i,
  /bad\s+gateway/i,
  /gateway\s+time-?out/i,
  /service\s+unavailable/i,
  /cpu\s+overloaded/i,
  /timeout/i,
];

const NON_RETRYABLE_REQUEST_PATTERNS: RegExp[] = [
  /invalid\s+request\s+body/i,
  /validation/i,
  /missing\s+required/i,
  /required\s+parameter/i,
  /unknown\s+parameter/i,
  /unrecognized\s+(field|key|parameter)/i,
  /malformed/i,
  /invalid\s+json/i,
  /cannot\s+parse/i,
  /unsupported\s+media\s+type/i,
];

function isModelUnsupportedErrorMessage(rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return MODEL_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text));
}

function matchesAnyPattern(patterns: RegExp[], rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyProxyFailureCategory(status?: number | null, upstreamErrorText?: string | null): RetryFailureCategory {
  const normalizedStatus = typeof status === 'number' && Number.isFinite(status)
    ? Math.trunc(status)
    : 0;
  const text = (upstreamErrorText || '').trim();

  if (normalizedStatus === 0) return 'network';
  if (normalizedStatus === 401 || normalizedStatus === 403) return 'auth';
  if (normalizedStatus === 429 || /rate\s+limit|quota/i.test(text)) return 'rate_limit';
  if (normalizedStatus === 413 || /payload\s+too\s+large|context\s+length|maximum\s+context/i.test(text)) {
    return 'payload_too_large';
  }
  if (isModelUnsupportedErrorMessage(text)) return 'model_unsupported';
  if (matchesAnyPattern(NON_RETRYABLE_REQUEST_PATTERNS, text)) return 'bad_request';
  if (
    normalizedStatus === 408
    || normalizedStatus === 409
    || normalizedStatus === 425
    || /timeout|timed?\s*out|connection\s+reset|connection\s+refused|econnreset|econnrefused/i.test(text)
  ) {
    return 'network';
  }
  if (normalizedStatus >= 500) return 'server';
  if (normalizedStatus >= 400) return 'bad_request';
  return 'other';
}

export function shouldRetryProxyRequest(status: number, upstreamErrorText?: string | null): boolean {
  if (status >= 500) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status === 401 || status === 403) return true;
  if (isModelUnsupportedErrorMessage(upstreamErrorText)) return true;
  if (matchesAnyPattern(NON_RETRYABLE_REQUEST_PATTERNS, upstreamErrorText)) return false;
  if (matchesAnyPattern(RETRYABLE_CHANNEL_LOCAL_PATTERNS, upstreamErrorText)) return true;
  if (status === 400 || status === 404 || status === 422) return false;
  return false;
}
