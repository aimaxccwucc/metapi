import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildConfig, buildFastifyOptions } from './config.js';

describe('buildConfig', () => {
  it('defaults to external listen host for server deployments', () => {
    const config = buildConfig({});

    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.port).toBe(4000);
    expect(config.dataDir).toBe('./data');
  });

  it('uses the same listen host and data dir rules for custom runtime environments', () => {
    const config = buildConfig({
      HOST: '0.0.0.0',
      PORT: '4312',
      DATA_DIR: '/tmp/metapi-data',
    });

    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.port).toBe(4312);
    expect(config.dataDir).toBe('/tmp/metapi-data');
  });

  it('honors explicit loopback host overrides', () => {
    const config = buildConfig({
      HOST: '127.0.0.1',
    });

    expect(config.listenHost).toBe('127.0.0.1');
  });

  it('defaults telegram api base url to the official endpoint', () => {
    const config = buildConfig({});

    expect(config.telegramApiBaseUrl).toBe('https://api.telegram.org');
    expect(config.telegramMessageThreadId).toBe('');
  });

  it('accepts telegram message thread id from environment', () => {
    const config = buildConfig({
      TELEGRAM_MESSAGE_THREAD_ID: '77',
    });

    expect(config.telegramMessageThreadId).toBe('77');
  });

  it('ships CLI-aligned OAuth defaults', () => {
    const config = buildConfig({});

    expect(config.codexClientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(config.codexResponsesWebsocketBeta).toBe('responses_websockets=2026-02-06');
    expect(config.claudeClientId).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(config.claudeClientSecret).toBe('');
    expect(config.geminiCliClientId).toBe('681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    expect(config.geminiCliClientSecret).toBe('');
    expect(config.upstreamRequestTimeoutMs).toBe(20_000);
    expect(config.upstreamStreamFirstByteTimeoutMs).toBe(45_000);
    expect(config.upstreamRequestBudgetMs).toBe(120_000);
    expect(config.upstreamStreamIdleTimeoutMs).toBe(180_000);
    expect(config.onDemandModelRefreshCooldownMs).toBe(15_000);
    expect(config.proxyMaxRetries).toBe(4);
    expect(config.downstreamAuthCacheTtlMs).toBe(15_000);
    expect(config.downstreamAuthNegativeCacheTtlMs).toBe(5_000);
    expect(config.responseCacheTtlMs).toBe(3_600_000);
    expect(config.responseCacheMaxRows).toBe(2_000);
    expect(config.responseCacheStaleIfErrorMs).toBe(600_000);
    expect(config.responseCacheInflightTtlMs).toBe(30_000);
    expect(config.slowSuccessLatencyThresholdMs).toBe(15_000);
    expect(config.slowSuccessPenaltyScore).toBe(0.25);
    expect(config.proxyEmptyContentFailEnabled).toBe(true);
  });

  it('allows overriding the codex websocket beta gate from environment', () => {
    const config = buildConfig({
      CODEX_RESPONSES_WEBSOCKET_BETA: 'responses_websockets=2099-01-01',
    });

    expect(config.codexResponsesWebsocketBeta).toBe('responses_websockets=2099-01-01');
  });

  it('accepts upstream timeout overrides from environment', () => {
    const config = buildConfig({
      UPSTREAM_REQUEST_TIMEOUT_MS: '28000',
      UPSTREAM_STREAM_FIRST_BYTE_TIMEOUT_MS: '9000',
      UPSTREAM_REQUEST_BUDGET_MS: '45000',
      UPSTREAM_STREAM_IDLE_TIMEOUT_MS: '12000',
      ON_DEMAND_MODEL_REFRESH_COOLDOWN_MS: '22000',
      PROXY_MAX_RETRIES: '5',
      DOWNSTREAM_AUTH_CACHE_TTL_MS: '30000',
      DOWNSTREAM_AUTH_NEGATIVE_CACHE_TTL_MS: '7000',
      RESPONSE_CACHE_TTL_MS: '1800000',
      RESPONSE_CACHE_MAX_ROWS: '1200',
      RESPONSE_CACHE_STALE_IF_ERROR_MS: '300000',
      RESPONSE_CACHE_INFLIGHT_TTL_MS: '45000',
      SLOW_SUCCESS_LATENCY_THRESHOLD_MS: '18000',
      SLOW_SUCCESS_PENALTY_SCORE: '0.4',
    });

    expect(config.upstreamRequestTimeoutMs).toBe(28_000);
    expect(config.upstreamStreamFirstByteTimeoutMs).toBe(9_000);
    expect(config.upstreamRequestBudgetMs).toBe(45_000);
    expect(config.upstreamStreamIdleTimeoutMs).toBe(12_000);
    expect(config.onDemandModelRefreshCooldownMs).toBe(22_000);
    expect(config.proxyMaxRetries).toBe(5);
    expect(config.downstreamAuthCacheTtlMs).toBe(30_000);
    expect(config.downstreamAuthNegativeCacheTtlMs).toBe(7_000);
    expect(config.responseCacheTtlMs).toBe(1_800_000);
    expect(config.responseCacheMaxRows).toBe(1_200);
    expect(config.responseCacheStaleIfErrorMs).toBe(300_000);
    expect(config.responseCacheInflightTtlMs).toBe(45_000);
    expect(config.slowSuccessLatencyThresholdMs).toBe(18_000);
    expect(config.slowSuccessPenaltyScore).toBe(0.4);
  });

  it('parses gateway stability runtime flags from environment', () => {
    const config = buildConfig({
      DISABLE_CROSS_PROTOCOL_FALLBACK: 'true',
      GLOBAL_ALLOWED_MODELS: 'gpt-*, claude-sonnet-*',
      PROXY_DEBUG_TRACE_ENABLED: 'true',
      PROXY_DEBUG_TRACE_MAX_ENTRIES: '777',
      PROXY_EMPTY_CONTENT_FAIL: 'false',
    });

    expect(config.disableCrossProtocolFallback).toBe(true);
    expect(config.globalAllowedModels).toEqual(['gpt-*', 'claude-sonnet-*']);
    expect(config.proxyDebugTraceEnabled).toBe(true);
    expect(config.proxyDebugTraceMaxEntries).toBe(777);
    expect(config.proxyEmptyContentFailEnabled).toBe(false);
  });

  it('clamps proxy debug trace max entries to the supported upper bound', () => {
    const config = buildConfig({
      PROXY_DEBUG_TRACE_MAX_ENTRIES: '99999',
    });

    expect(config.proxyDebugTraceMaxEntries).toBe(5000);
  });

  it('accepts JSON request bodies larger than Fastify default 1 MiB', async () => {
    const app = Fastify(buildFastifyOptions(buildConfig({})));
    const largeText = 'a'.repeat(2 * 1024 * 1024);

    app.post('/echo', async (request) => {
      const body = request.body as { text?: string };
      return { textLength: body.text?.length ?? 0 };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { text: largeText },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ textLength: largeText.length });
    await app.close();
  });
});
