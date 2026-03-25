import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type SiteProtocolConfigServiceModule = typeof import('./siteProtocolConfigService.js');

describe('siteProtocolConfigService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let resolveSiteProtocolConfig: SiteProtocolConfigServiceModule['resolveSiteProtocolConfig'];
  let upsertSiteProtocolConfig: SiteProtocolConfigServiceModule['upsertSiteProtocolConfig'];
  let flushSiteProtocolConfigPersistence: SiteProtocolConfigServiceModule['flushSiteProtocolConfigPersistence'];
  let resetSiteProtocolConfigState: SiteProtocolConfigServiceModule['resetSiteProtocolConfigState'];
  let applyManualSiteProtocolConfig: SiteProtocolConfigServiceModule['applyManualSiteProtocolConfig'];
  let normalizeSiteProtocolConfigInput: SiteProtocolConfigServiceModule['normalizeSiteProtocolConfigInput'];
  let sanitizeSiteProtocolConfigForPlatform: SiteProtocolConfigServiceModule['sanitizeSiteProtocolConfigForPlatform'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-protocol-config-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./siteProtocolConfigService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    resolveSiteProtocolConfig = serviceModule.resolveSiteProtocolConfig;
    upsertSiteProtocolConfig = serviceModule.upsertSiteProtocolConfig;
    flushSiteProtocolConfigPersistence = serviceModule.flushSiteProtocolConfigPersistence;
    resetSiteProtocolConfigState = serviceModule.resetSiteProtocolConfigState;
    applyManualSiteProtocolConfig = serviceModule.applyManualSiteProtocolConfig;
    normalizeSiteProtocolConfigInput = serviceModule.normalizeSiteProtocolConfigInput;
    sanitizeSiteProtocolConfigForPlatform = serviceModule.sanitizeSiteProtocolConfigForPlatform;
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    resetSiteProtocolConfigState();
  });

  afterAll(() => {
    resetSiteProtocolConfigState();
    delete process.env.DATA_DIR;
  });

  it('persists and reloads manual site protocol config from settings', async () => {
    await upsertSiteProtocolConfig(12, {
      mode: 'manual',
      supportedEndpoints: ['responses', 'chat'],
      preferredEndpoint: 'responses',
      updatedAtMs: Date.now(),
    });
    await flushSiteProtocolConfigPersistence();
    resetSiteProtocolConfigState();

    const config = await resolveSiteProtocolConfig(12);
    expect(config).toEqual({
      mode: 'manual',
      supportedEndpoints: ['responses', 'chat'],
      preferredEndpoint: 'responses',
      updatedAtMs: expect.any(Number),
    });
  });

  it('constrains candidates by manual site protocol config', async () => {
    await upsertSiteProtocolConfig(15, {
      mode: 'manual',
      supportedEndpoints: ['responses', 'chat'],
      preferredEndpoint: 'responses',
      updatedAtMs: Date.now(),
    });

    const result = await applyManualSiteProtocolConfig(['chat', 'messages', 'responses'], 15, 'new-api');
    expect(result.candidates).toEqual(['responses', 'chat']);
    expect(result.config?.mode).toBe('manual');
  });

  it('rejects unsupported manual protocol endpoints for the current platform', () => {
    expect(normalizeSiteProtocolConfigInput({
      mode: 'manual',
      supportedEndpoints: ['messages'],
      preferredEndpoint: 'messages',
    }, 'codex')).toEqual({
      valid: false,
      present: true,
      error: 'protocolConfig contains unsupported endpoints for the current site platform.',
    });
  });

  it('sanitizes stored protocol config after a platform change', () => {
    expect(sanitizeSiteProtocolConfigForPlatform({
      mode: 'manual',
      supportedEndpoints: ['responses', 'chat'],
      preferredEndpoint: 'responses',
      updatedAtMs: 123,
    }, 'codex')).toEqual({
      mode: 'manual',
      supportedEndpoints: ['responses'],
      preferredEndpoint: 'responses',
      updatedAtMs: 123,
    });
  });
});
