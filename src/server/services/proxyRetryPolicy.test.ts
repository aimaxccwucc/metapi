import { describe, expect, it } from 'vitest';
import { classifyProxyFailureCategory, shouldAvoidSiteForRequest, shouldRetryProxyRequest } from './proxyRetryPolicy.js';

describe('proxyRetryPolicy', () => {
  it('retries on rate limit and server errors', () => {
    expect(shouldRetryProxyRequest(429, 'rate limit')).toBe(true);
    expect(shouldRetryProxyRequest(500, 'internal error')).toBe(true);
    expect(shouldRetryProxyRequest(503, 'service unavailable')).toBe(true);
  });

  it('retries on model unsupported messages from upstream', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":"当前 API 不支持所选模型 claude-sonnet-4-5-20250929","type":"error"}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"unsupported model: claude-3"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"The model `gpt-4.1` does not exist"}}'),
    ).toBe(true);
  });

  it('does not retry obvious request-shape errors that will fail on every channel', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"invalid request body"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(422, '{"error":{"message":"unprocessable"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"not found"}}'),
    ).toBe(false);
  });

  it('keeps retrying channel-local compatibility and auth failures', () => {
    expect(
      shouldRetryProxyRequest(401, '{"error":{"message":"invalid access token"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(403, '{"error":{"message":"forbidden"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, 'Missing required parameter: \'input[90].name\'.'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, 'No tool call found for function call output with call_id call_123.'),
    ).toBe(true);
  });

  it('classifies auth-like 400 responses as auth failures for stronger channel避让', () => {
    expect(classifyProxyFailureCategory(400, 'invalid api key')).toBe('auth');
    expect(classifyProxyFailureCategory(400, 'Access token has expired')).toBe('auth');
  });

  it('classifies text-based quota failures as rate_limit', () => {
    expect(classifyProxyFailureCategory(400, 'quota exceeded')).toBe('rate_limit');
    expect(classifyProxyFailureCategory(400, 'too many requests')).toBe('rate_limit');
  });

  it('classifies explicit 403 model denial as model_unsupported before generic auth', () => {
    expect(
      classifyProxyFailureCategory(403, '{"error":{"message":"you do not have access to the model gpt-5.2"}}'),
    ).toBe('model_unsupported');
  });

  it('only marks transient site-level failures for request-scoped site avoidance', () => {
    expect(shouldAvoidSiteForRequest(502, 'bad gateway')).toBe(true);
    expect(shouldAvoidSiteForRequest(429, 'rate limit exceeded')).toBe(true);
    expect(shouldAvoidSiteForRequest(0, 'socket hang up')).toBe(true);
    expect(shouldAvoidSiteForRequest(400, 'unsupported model')).toBe(false);
    expect(shouldAvoidSiteForRequest(401, 'invalid api key')).toBe(false);
    expect(shouldAvoidSiteForRequest(403, 'forbidden')).toBe(false);
    expect(shouldAvoidSiteForRequest(400, 'invalid request body')).toBe(false);
  });
});
