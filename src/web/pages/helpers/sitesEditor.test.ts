import { describe, expect, it } from 'vitest';
import { buildSiteSaveAction, emptySiteForm, siteFormFromSite } from './sitesEditor.js';

describe('buildSiteSaveAction', () => {
  it('returns add action in add mode', () => {
    const action = buildSiteSaveAction(
      { mode: 'add' },
      {
        name: 'site-a',
        url: 'https://a.example.com/',
        externalCheckinUrl: 'https://checkin.a.example.com',
        platform: 'new-api',
        proxyUrl: 'http://127.0.0.1:7890',
        globalWeight: '1.2',
      },
    );

    expect(action).toEqual({
      kind: 'add',
      payload: {
        name: 'site-a',
        url: 'https://a.example.com/',
        externalCheckinUrl: 'https://checkin.a.example.com',
        platform: 'new-api',
        proxyUrl: 'http://127.0.0.1:7890',
        globalWeight: '1.2',
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
        globalWeight: '0.8',
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
        globalWeight: '0.8',
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
          globalWeight: '1',
        },
      ),
    ).toThrow('editingSiteId is required in edit mode');
  });

  it('does not expose deprecated apiKey in site editor state', () => {
    expect(emptySiteForm()).not.toHaveProperty('apiKey');
    expect(siteFormFromSite({
      name: 'site-d',
      url: 'https://d.example.com',
      externalCheckinUrl: null,
      platform: 'new-api',
      proxyUrl: null,
      globalWeight: 1,
      apiKey: 'sk-legacy-site-key',
    })).not.toHaveProperty('apiKey');
  });
});
