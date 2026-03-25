import { describe, expect, it } from 'vitest';
import {
  buildSiteSaveAction,
  emptySiteCustomHeader,
  emptySiteForm,
  getAllowedProtocolEndpointsForPlatform,
  serializeSiteCustomHeaders,
  siteFormFromSite,
} from './sitesEditor.js';

describe('buildSiteSaveAction', () => {
  it('returns add action in add mode', () => {
    const action = buildSiteSaveAction(
      { mode: 'add' },
      {
        name: 'site-a',
        url: 'https://a.example.com/',
        externalCheckinUrl: 'https://checkin.a.example.com',
        platform: 'new-api',
        proxyUrl: 'socks5://127.0.0.1:1080',
        customHeaders: '{"x-site-token":"alpha"}',
        useSystemProxy: false,
        globalWeight: 1.2,
        protocolConfig: {
          mode: 'manual',
          supportedEndpoints: ['responses', 'chat'],
          preferredEndpoint: 'responses',
        },
      },
    );

    expect(action).toEqual({
      kind: 'add',
      payload: {
        name: 'site-a',
        url: 'https://a.example.com/',
        externalCheckinUrl: 'https://checkin.a.example.com',
        platform: 'new-api',
        proxyUrl: 'socks5://127.0.0.1:1080',
        customHeaders: '{"x-site-token":"alpha"}',
        useSystemProxy: false,
        globalWeight: 1.2,
        protocolConfig: {
          mode: 'manual',
          supportedEndpoints: ['responses', 'chat'],
          preferredEndpoint: 'responses',
        },
      },
    });
  });

  it('returns update action in edit mode with site id', () => {
    const action = buildSiteSaveAction(
      { mode: 'edit', editingSiteId: 12 },
      {
        name: 'site-b',
        url: 'https://b.example.com',
        externalCheckinUrl: '',
        platform: 'one-api',
        proxyUrl: '',
        useSystemProxy: true,
        customHeaders: '',
        globalWeight: 0.8,
        protocolConfig: {
          mode: 'auto',
          supportedEndpoints: [],
          preferredEndpoint: null,
        },
      },
    );

    expect(action).toEqual({
      kind: 'update',
      id: 12,
      payload: {
        name: 'site-b',
        url: 'https://b.example.com',
        externalCheckinUrl: '',
        platform: 'one-api',
        proxyUrl: '',
        useSystemProxy: true,
        customHeaders: '',
        globalWeight: 0.8,
        protocolConfig: {
          mode: 'auto',
          supportedEndpoints: [],
          preferredEndpoint: null,
        },
      },
    });
  });

  it('throws when edit mode has no site id', () => {
    expect(() =>
      buildSiteSaveAction(
        { mode: 'edit' },
        {
          name: 'site-c',
          url: 'https://c.example.com',
          externalCheckinUrl: '',
          platform: '',
          proxyUrl: '',
          useSystemProxy: false,
          customHeaders: '',
          globalWeight: 1,
          protocolConfig: {
            mode: 'auto',
            supportedEndpoints: [],
            preferredEndpoint: null,
          },
        },
      ),
    ).toThrow('editingSiteId is required in edit mode');
  });

  it('does not expose deprecated apiKey in site editor state', () => {
    expect(emptySiteForm()).not.toHaveProperty('apiKey');
    expect(emptySiteForm().customHeaders).toEqual([emptySiteCustomHeader()]);
    expect(emptySiteForm().proxyUrl).toBe('');
    expect(emptySiteForm().protocolMode).toBe('auto');
    expect(emptySiteForm().supportedEndpoints).toEqual([]);
    expect(siteFormFromSite({
      name: 'site-d',
      url: 'https://d.example.com',
      externalCheckinUrl: null,
      platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:8080',
      customHeaders: '{"x-site-token":"alpha"}',
      globalWeight: 1,
      apiKey: 'sk-legacy-site-key',
    })).not.toHaveProperty('apiKey');
    expect(siteFormFromSite({
      proxyUrl: 'http://127.0.0.1:8080',
    }).proxyUrl).toBe('http://127.0.0.1:8080');
  });

  it('parses custom headers json into key value rows', () => {
    expect(siteFormFromSite({
      name: 'site-e',
      customHeaders: '{"x-site-token":"alpha","cf-access-client-id":"beta"}',
    }).customHeaders).toEqual([
      { key: 'x-site-token', value: 'alpha' },
      { key: 'cf-access-client-id', value: 'beta' },
    ]);
  });

  it('parses manual protocol config into editor fields', () => {
    expect(siteFormFromSite({
      protocolConfig: {
        mode: 'manual',
        supportedEndpoints: ['chat', 'responses'],
        preferredEndpoint: 'responses',
      },
    })).toMatchObject({
      protocolMode: 'manual',
      supportedEndpoints: ['chat', 'responses'],
      preferredEndpoint: 'responses',
    });
  });

  it('filters unsupported protocol endpoints from the editor when the platform changes', () => {
    expect(siteFormFromSite({
      platform: 'codex',
      protocolConfig: {
        mode: 'manual',
        supportedEndpoints: ['chat', 'responses'],
        preferredEndpoint: 'chat',
      },
    })).toMatchObject({
      protocolMode: 'manual',
      supportedEndpoints: ['responses'],
      preferredEndpoint: '',
    });
  });

  it('returns platform-aware allowed protocol endpoints', () => {
    expect(getAllowedProtocolEndpointsForPlatform('codex')).toEqual(['responses']);
    expect(getAllowedProtocolEndpointsForPlatform('claude')).toEqual(['messages']);
    expect(getAllowedProtocolEndpointsForPlatform('gemini')).toEqual(['responses', 'chat']);
  });

  it('serializes key value rows into json', () => {
    expect(serializeSiteCustomHeaders([
      { key: 'x-site-token', value: 'alpha' },
      { key: 'cf-access-client-id', value: 'beta' },
      emptySiteCustomHeader(),
    ])).toEqual({
      valid: true,
      customHeaders: '{"x-site-token":"alpha","cf-access-client-id":"beta"}',
    });
  });

  it('rejects duplicate custom header names case-insensitively', () => {
    expect(serializeSiteCustomHeaders([
      { key: 'Authorization', value: 'Bearer a' },
      { key: 'authorization', value: 'Bearer b' },
    ])).toEqual({
      valid: false,
      customHeaders: '',
      error: '请求头 "authorization" 重复了',
    });
  });
});
