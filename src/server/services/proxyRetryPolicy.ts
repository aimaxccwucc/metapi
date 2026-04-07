import { hasExplicitEndpointCompatibilitySignal } from '../transformers/shared/endpointCompatibility.js';

export type RetryFailureCategory =
  | 'network'
  | 'server'
  | 'rate_limit'
  | 'upstream_group_empty'
  | 'payload_too_large'
  | 'model_unsupported'
  | 'auth'
  | 'invalid_channel'
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

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /invalid\s+api\s+key/i,
  /invalid[_\s-]?api[_\s-]?key/i,
  /api\s+key\s+not\s+found/i,
  /invalid\s+access\s+token/i,
  /access\s+token\s+has\s+expired/i,
  /expired\s+access\s+token/i,
  /expired\s+token/i,
  /authentication\s+failed/i,
  /unauthorized/i,
  /forbidden/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate\s+limit/i,
  /too\s+many\s+requests/i,
  /quota/i,
  /retry\s+after/i,
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
  /no\s+tool\s+call\s+found\s+for\s+function\s+call\s+output/i,
  /missing\s+required\s+parameter:\s*['"]?input\[\d+\]\.name['"]?/i,
  /missing\s+required\s+parameter:\s*['"]?input\[\d+\]/i,
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

const RETRYABLE_UPSTREAM_COMPATIBILITY_400_PATTERNS: RegExp[] = [
  /no\s+tool\s+call\s+found\s+for\s+function\s+call\s+output/i,
  /missing\s+required\s+parameter:\s*['"]?input\[\d+\]\.name['"]?/i,
];

const RETRYABLE_CHANNEL_LOCAL_404_PATTERNS: RegExp[] = [
  /\bopenai_error\b/i,
  /\bbad_response_status_code\b/i,
  /not[_\s-]?found[_\s-]?error/i,
];

const INVALID_CHANNEL_PATTERNS: RegExp[] = [
  /\bopenai_error\b/i,
  /\bbad_response_status_code\b/i,
  /\brequest_error\b/i,
  /\bnot[_\s-]?found[_\s-]?error\b/i,
  /upstream\s+returned\s+http\s+404/i,
  /unsupported\s+endpoint/i,
  /unsupported\s+path/i,
  /unrecognized\s+request\s+url/i,
  /does\s+not\s+allow\s+\/v1\//i,
  /无权访问\s*.+\s*分组/i,
  /no\s+access\s+to\s+group/i,
];

const SITE_AVOID_INVALID_CHANNEL_PATTERNS: RegExp[] = [
  /无权访问\s*.+\s*分组/i,
  /no\s+access\s+to\s+group/i,
];

const UPSTREAM_GROUP_EMPTY_PATTERNS: RegExp[] = [
  /no\s+available\s+channel\s+for\s+model/i,
  /under\s+group\s+.+\(distributor\)/i,
  /billing\s+service\s+temporarily\s+unavailable/i,
  /偷偷倒闭/i,
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

function isRetryableUpstreamCompatibility400(rawMessage?: string | null): boolean {
  return matchesAnyPattern(RETRYABLE_UPSTREAM_COMPATIBILITY_400_PATTERNS, rawMessage);
}

function isRetryableChannelLocal404(rawMessage?: string | null): boolean {
  return matchesAnyPattern(RETRYABLE_CHANNEL_LOCAL_404_PATTERNS, rawMessage)
    || hasExplicitEndpointCompatibilitySignal(rawMessage);
}

export function classifyProxyFailureCategory(status?: number | null, upstreamErrorText?: string | null): RetryFailureCategory {
  const normalizedStatus = typeof status === 'number' && Number.isFinite(status)
    ? Math.trunc(status)
    : 0;
  const text = (upstreamErrorText || '').trim();

  if (normalizedStatus === 0) return 'network';
  if (isModelUnsupportedErrorMessage(text)) return 'model_unsupported';
  if (normalizedStatus === 503 && matchesAnyPattern(UPSTREAM_GROUP_EMPTY_PATTERNS, text)) return 'upstream_group_empty';
  if ((normalizedStatus === 404 || normalizedStatus === 410) && isRetryableChannelLocal404(text)) return 'invalid_channel';
  if ((normalizedStatus === 400 || normalizedStatus === 403 || normalizedStatus === 404 || normalizedStatus === 410 || normalizedStatus === 422)
    && matchesAnyPattern(INVALID_CHANNEL_PATTERNS, text)) {
    return 'invalid_channel';
  }
  if (normalizedStatus === 401 || normalizedStatus === 403) return 'auth';
  if (matchesAnyPattern(AUTH_FAILURE_PATTERNS, text)) return 'auth';
  if (normalizedStatus === 429 || matchesAnyPattern(RATE_LIMIT_PATTERNS, text)) return 'rate_limit';
  if (normalizedStatus === 413 || /payload\s+too\s+large|context\s+length|maximum\s+context/i.test(text)) {
    return 'payload_too_large';
  }
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
  const category = classifyProxyFailureCategory(status, upstreamErrorText);
  if (category === 'upstream_group_empty' || category === 'invalid_channel') return true;
  if (status >= 500) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status === 401 || status === 403) return true;
  if (isModelUnsupportedErrorMessage(upstreamErrorText)) return true;
  if (status === 400 && isRetryableUpstreamCompatibility400(upstreamErrorText)) return true;
  if (status === 404 && isRetryableChannelLocal404(upstreamErrorText)) return true;
  if (matchesAnyPattern(NON_RETRYABLE_REQUEST_PATTERNS, upstreamErrorText)) return false;
  if (matchesAnyPattern(RETRYABLE_CHANNEL_LOCAL_PATTERNS, upstreamErrorText)) return true;
  if (status === 400 || status === 404 || status === 422) return false;
  return false;
}

export function shouldAvoidSiteForRequest(status?: number | null, upstreamErrorText?: string | null): boolean {
  const category = classifyProxyFailureCategory(status, upstreamErrorText);
  if (category === 'invalid_channel' && matchesAnyPattern(SITE_AVOID_INVALID_CHANNEL_PATTERNS, upstreamErrorText)) {
    return true;
  }
  return category === 'network' || category === 'server' || category === 'rate_limit';
}
