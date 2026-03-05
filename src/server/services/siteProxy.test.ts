import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');

describe('siteProxy', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-proxy-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    const { invalidateSiteProxyCache } = await import('./siteProxy.js');
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateSiteProxyCache();
    delete process.env.DEFAULT_SITE_PROXY_URL;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('resolves longest matched site proxy url', async () => {
    await db.insert(schema.sites).values([
      {
        name: 'base-site',
        url: 'https://relay.example.com',
        platform: 'new-api',
        proxyUrl: 'http://127.0.0.1:7891',
      },
      {
        name: 'openai-site',
        url: 'https://relay.example.com/openai',
        platform: 'new-api',
        proxyUrl: 'http://127.0.0.1:7890',
      },
    ]).run();

    const { resolveSiteProxyUrlByRequestUrl } = await import('./siteProxy.js');
    expect(await resolveSiteProxyUrlByRequestUrl('https://relay.example.com/openai/v1/models'))
      .toBe('http://127.0.0.1:7890');
    expect(await resolveSiteProxyUrlByRequestUrl('https://relay.example.com/v1/models'))
      .toBe('http://127.0.0.1:7891');
  });

  it('injects dispatcher when proxy exists', async () => {
    await db.insert(schema.sites).values({
      name: 'proxy-site',
      url: 'https://proxy-site.example.com',
      platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:7890',
    }).run();

    const { withSiteProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = await withSiteProxyRequestInit('https://proxy-site.example.com/v1/chat/completions', {
      method: 'POST',
    });

    expect('dispatcher' in requestInit).toBe(true);
  });

  it('falls back to default proxy when site proxy is absent', async () => {
    process.env.DEFAULT_SITE_PROXY_URL = 'http://127.0.0.1:7897';
    const { withSiteProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = await withSiteProxyRequestInit('https://no-proxy.example.com/v1/models', {
      method: 'GET',
    });
    expect('dispatcher' in requestInit).toBe(true);
  });

  it('uses default proxy in explicit proxy helper when argument is empty', async () => {
    process.env.DEFAULT_SITE_PROXY_URL = 'http://127.0.0.1:7897';
    const { withExplicitProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = withExplicitProxyRequestInit('', {
      method: 'GET',
    });
    expect('dispatcher' in requestInit).toBe(true);
  });
});
