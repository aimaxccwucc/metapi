import { describe, expect, it } from 'vitest';
import { classifyProxyFailureCategory, shouldAvoidSiteForRequest, shouldRetryProxyRequest } from './proxyRetryPolicy.js';

describe('proxyRetryPolicy', () => {
  it('retries on rate limit and server errors', () => {
    expect(shouldRetryProxyRequest(429, 'rate limit')).toBe(true);
    expect(shouldRetryProxyRequest(500, 'internal error')).toBe(true);
    expect(shouldRetryProxyRequest(503, 'service unavailable')).toBe(true);
    expect(shouldRetryProxyRequest(429, 'All credentials for model gpt-5.4 are cooling down via provider codex')).toBe(true);
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

  it('retries channel-local 404 wrappers that usually come from gateway compatibility layers', () => {
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"openai_error","type":"bad_response_status_code","code":"bad_response_status_code"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"Not Found","type":"not_found_error"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(404, 'unrecognized request url: POST /v1/chat/completions'),
    ).toBe(true);
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
    expect(
      shouldRetryProxyRequest(400, 'blocked_invalid_request: request body matches a previously blocked invalid request'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, "Unknown parameter: 'tool_choice.function'."),
    ).toBe(true);
  });

  it('classifies auth-like 400 responses as auth failures for stronger channel避让', () => {
    expect(classifyProxyFailureCategory(400, 'invalid api key')).toBe('auth');
    expect(classifyProxyFailureCategory(400, 'Access token has expired')).toBe('auth');
  });

  it('classifies text-based quota failures as rate_limit', () => {
    expect(classifyProxyFailureCategory(400, 'quota exceeded')).toBe('rate_limit');
    expect(classifyProxyFailureCategory(400, 'too many requests')).toBe('rate_limit');
    expect(classifyProxyFailureCategory(429, 'All credentials for model gpt-5.4 are cooling down via provider codex')).toBe('rate_limit');
    expect(classifyProxyFailureCategory(429, '{"error":{"message":"All credentials for model gpt-5.4 are cooling down via provider codex","code":"model_cooldown"}}')).toBe('rate_limit');
  });

  it('classifies invalid channel wrappers and empty upstream groups separately', () => {
    expect(
      classifyProxyFailureCategory(404, '{"error":{"message":"openai_error","type":"bad_response_status_code"}}'),
    ).toBe('invalid_channel');
    expect(
      classifyProxyFailureCategory(403, '{"error":{"message":"request_error"}}'),
    ).toBe('invalid_channel');
    expect(
      classifyProxyFailureCategory(403, '无权访问 cc2kpro 分组'),
    ).toBe('invalid_channel');
    expect(
      classifyProxyFailureCategory(400, 'No tool call found for function call output with call_id call_123.'),
    ).toBe('invalid_channel');
    expect(
      classifyProxyFailureCategory(400, 'No tool output found for function call call_123.'),
    ).toBe('invalid_channel');
    expect(
      classifyProxyFailureCategory(400, 'blocked_invalid_request: request body matches a previously blocked invalid request'),
    ).toBe('invalid_channel');
    expect(
      classifyProxyFailureCategory(400, "Unknown parameter: 'tool_choice.function'."),
    ).toBe('invalid_channel');
    expect(
      classifyProxyFailureCategory(503, 'No available channel for model gpt-5.4 under group default (distributor)'),
    ).toBe('upstream_group_empty');
    expect(
      classifyProxyFailureCategory(503, '分组 Fovt 下模型 claude-opus-4-6-thinking 无可用渠道（distributor）'),
    ).toBe('upstream_group_empty');
    expect(
      classifyProxyFailureCategory(503, 'No available providers (cch_session_id: sess_123)'),
    ).toBe('upstream_group_empty');
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
    expect(shouldAvoidSiteForRequest(403, '无权访问 cc2kpro 分组')).toBe(true);
    expect(shouldAvoidSiteForRequest(400, 'No tool call found for function call output with call_id call_123.')).toBe(true);
    expect(shouldAvoidSiteForRequest(400, 'No tool output found for function call call_123.')).toBe(true);
    expect(shouldAvoidSiteForRequest(400, 'blocked_invalid_request: request body matches a previously blocked invalid request')).toBe(true);
    expect(shouldAvoidSiteForRequest(400, "Unknown parameter: 'tool_choice.function'.")).toBe(true);
    expect(shouldAvoidSiteForRequest(429, 'All credentials for model gpt-5.4 are cooling down via provider codex')).toBe(true);
    expect(shouldAvoidSiteForRequest(400, '{"error":{"message":"openai_error","type":"bad_response_status_code","code":"bad_response_status_code"}}')).toBe(true);
    expect(shouldAvoidSiteForRequest(503, 'No available channel for model gpt-5.4 under group default (distributor)')).toBe(true);
    expect(shouldAvoidSiteForRequest(400, 'unsupported model')).toBe(false);
    expect(shouldAvoidSiteForRequest(401, 'invalid api key')).toBe(false);
    expect(shouldAvoidSiteForRequest(403, 'forbidden')).toBe(false);
    expect(shouldAvoidSiteForRequest(400, 'invalid request body')).toBe(false);
  });
});
