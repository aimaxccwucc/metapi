import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fetchModelPricingCatalogMock = vi.fn(async (_arg?: unknown): Promise<any> => null);

vi.mock('../../services/modelPricingService.js', () => ({
  fetchModelPricingCatalog: (arg: unknown) => fetchModelPricingCatalogMock(arg),
}));

type DbModule = typeof import('../../db/index.js');
type UpstreamEndpointModule = typeof import('./upstreamEndpoint.js');
type UpstreamProtocolProfileModule = typeof import('../../services/upstreamProtocolProfile.js');

const baseContext = {
  site: {
    id: 1,
    url: 'https://upstream.example.com',
    platform: 'new-api',
    apiKey: null,
  },
  account: {
    id: 2,
    accessToken: 'token-demo',
    apiToken: null,
  },
};

describe('upstream endpoint persisted protocol profile', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let resolveUpstreamEndpointCandidates: UpstreamEndpointModule['resolveUpstreamEndpointCandidates'];
  let recordUpstreamEndpointFailure: UpstreamEndpointModule['recordUpstreamEndpointFailure'];
  let recordUpstreamEndpointSuccess: UpstreamEndpointModule['recordUpstreamEndpointSuccess'];
  let resetUpstreamEndpointRuntimeState: UpstreamEndpointModule['resetUpstreamEndpointRuntimeState'];
  let flushUpstreamProtocolProfilePersistence: UpstreamProtocolProfileModule['flushUpstreamProtocolProfilePersistence'];
  let clearPersistedUpstreamProtocolProfileState: UpstreamProtocolProfileModule['clearPersistedUpstreamProtocolProfileState'];
  let resetUpstreamProtocolProfileState: UpstreamProtocolProfileModule['resetUpstreamProtocolProfileState'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-upstream-profile-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const upstreamEndpointModule = await import('./upstreamEndpoint.js');
    const upstreamProtocolProfileModule = await import('../../services/upstreamProtocolProfile.js');

    db = dbModule.db;
    schema = dbModule.schema;
    resolveUpstreamEndpointCandidates = upstreamEndpointModule.resolveUpstreamEndpointCandidates;
    recordUpstreamEndpointFailure = upstreamEndpointModule.recordUpstreamEndpointFailure;
    recordUpstreamEndpointSuccess = upstreamEndpointModule.recordUpstreamEndpointSuccess;
    resetUpstreamEndpointRuntimeState = upstreamEndpointModule.resetUpstreamEndpointRuntimeState;
    flushUpstreamProtocolProfilePersistence = upstreamProtocolProfileModule.flushUpstreamProtocolProfilePersistence;
    clearPersistedUpstreamProtocolProfileState = upstreamProtocolProfileModule.clearPersistedUpstreamProtocolProfileState;
    resetUpstreamProtocolProfileState = upstreamProtocolProfileModule.resetUpstreamProtocolProfileState;
  });

  beforeEach(async () => {
    fetchModelPricingCatalogMock.mockReset();
    fetchModelPricingCatalogMock.mockResolvedValue(null);
    resetUpstreamEndpointRuntimeState();
    resetUpstreamProtocolProfileState();
    await clearPersistedUpstreamProtocolProfileState();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    resetUpstreamEndpointRuntimeState();
    resetUpstreamProtocolProfileState();
    await clearPersistedUpstreamProtocolProfileState();
    delete process.env.DATA_DIR;
  });

  it('persists explicit suggested endpoint preferences after runtime reset', async () => {
    recordUpstreamEndpointFailure({
      siteId: baseContext.site.id,
      accountId: baseContext.account.id,
      accountAccessToken: baseContext.account.accessToken,
      accountApiToken: baseContext.account.apiToken,
      siteApiKey: baseContext.site.apiKey,
      endpoint: 'chat',
      downstreamFormat: 'openai',
      modelName: 'gpt-5.3',
      status: 400,
      errorText: 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.',
    });
    await flushUpstreamProtocolProfilePersistence();
    resetUpstreamEndpointRuntimeState();

    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
    );

    expect(order).toEqual(['responses', 'messages']);
  });

  it('still avoids persisting generic responses-to-messages redirect hints across runtime reset', async () => {
    recordUpstreamEndpointFailure({
      siteId: baseContext.site.id,
      accountId: baseContext.account.id,
      accountAccessToken: baseContext.account.accessToken,
      accountApiToken: baseContext.account.apiToken,
      siteApiKey: baseContext.site.apiKey,
      endpoint: 'responses',
      downstreamFormat: 'responses',
      modelName: 'gpt-5.3',
      status: 405,
      errorText: 'Method Not Allowed. Please use /v1/messages.',
    });
    await flushUpstreamProtocolProfilePersistence();
    resetUpstreamEndpointRuntimeState();

    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'responses',
    );

    expect(order).toEqual(['responses', 'chat']);
  });

  it('reloads successful endpoint preference from persisted profile after runtime reset', async () => {
    await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
    );
    recordUpstreamEndpointSuccess({
      siteId: baseContext.site.id,
      accountId: baseContext.account.id,
      accountAccessToken: baseContext.account.accessToken,
      accountApiToken: baseContext.account.apiToken,
      siteApiKey: baseContext.site.apiKey,
      endpoint: 'responses',
      downstreamFormat: 'openai',
      modelName: 'gpt-5.3',
    });
    await flushUpstreamProtocolProfilePersistence();
    resetUpstreamEndpointRuntimeState();

    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('reloads persisted endpoint preference only for the same account scope', async () => {
    const accountA = {
      ...baseContext,
      account: {
        id: 2,
        accessToken: 'token-a',
        apiToken: null,
      },
    };
    const accountB = {
      ...baseContext,
      account: {
        id: 3,
        accessToken: 'token-b',
        apiToken: null,
      },
    };

    await resolveUpstreamEndpointCandidates(
      accountA,
      'gpt-5.3',
      'openai',
    );
    recordUpstreamEndpointSuccess({
      siteId: accountA.site.id,
      accountId: accountA.account.id,
      accountAccessToken: accountA.account.accessToken,
      accountApiToken: accountA.account.apiToken,
      siteApiKey: accountA.site.apiKey,
      endpoint: 'responses',
      downstreamFormat: 'openai',
      modelName: 'gpt-5.3',
    });
    await flushUpstreamProtocolProfilePersistence();
    resetUpstreamEndpointRuntimeState();

    const orderA = await resolveUpstreamEndpointCandidates(
      accountA,
      'gpt-5.3',
      'openai',
    );
    const orderB = await resolveUpstreamEndpointCandidates(
      accountB,
      'gpt-5.3',
      'openai',
    );

    expect(orderA).toEqual(['responses', 'chat', 'messages']);
    expect(orderB).toEqual(['chat', 'messages', 'responses']);
  });

  it('reloads generic responses-to-chat fallback success for the same credential scope after runtime reset', async () => {
    await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'responses',
    );
    recordUpstreamEndpointSuccess({
      siteId: baseContext.site.id,
      accountId: baseContext.account.id,
      accountAccessToken: baseContext.account.accessToken,
      accountApiToken: baseContext.account.apiToken,
      siteApiKey: baseContext.site.apiKey,
      endpoint: 'chat',
      downstreamFormat: 'responses',
      modelName: 'gpt-5.3',
    });
    await flushUpstreamProtocolProfilePersistence();
    resetUpstreamEndpointRuntimeState();

    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'responses',
    );

    expect(order).toEqual(['chat', 'responses']);
  });

  it('reloads persisted endpoint preference only for the same model within one credential scope', async () => {
    await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
    );
    recordUpstreamEndpointSuccess({
      siteId: baseContext.site.id,
      accountId: baseContext.account.id,
      accountAccessToken: baseContext.account.accessToken,
      accountApiToken: baseContext.account.apiToken,
      siteApiKey: baseContext.site.apiKey,
      endpoint: 'responses',
      downstreamFormat: 'openai',
      modelName: 'gpt-5.3',
    });
    await flushUpstreamProtocolProfilePersistence();
    resetUpstreamEndpointRuntimeState();

    const sameModelOrder = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
    );
    const otherModelOrder = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-4.1',
      'openai',
    );

    expect(sameModelOrder).toEqual(['responses', 'chat', 'messages']);
    expect(otherModelOrder).toEqual(['chat', 'messages', 'responses']);
  });

  it('returns a single half-open endpoint from persisted profile when all candidates are blocked', async () => {
    recordUpstreamEndpointFailure({
      siteId: baseContext.site.id,
      accountId: baseContext.account.id,
      accountAccessToken: baseContext.account.accessToken,
      accountApiToken: baseContext.account.apiToken,
      siteApiKey: baseContext.site.apiKey,
      endpoint: 'chat',
      downstreamFormat: 'openai',
      modelName: 'gpt-5.3',
      status: 400,
      errorText: 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.',
    });
    recordUpstreamEndpointFailure({
      siteId: baseContext.site.id,
      accountId: baseContext.account.id,
      accountAccessToken: baseContext.account.accessToken,
      accountApiToken: baseContext.account.apiToken,
      siteApiKey: baseContext.site.apiKey,
      endpoint: 'responses',
      downstreamFormat: 'openai',
      modelName: 'gpt-5.3',
      status: 405,
      errorText: 'Method Not Allowed',
    });
    recordUpstreamEndpointFailure({
      siteId: baseContext.site.id,
      accountId: baseContext.account.id,
      accountAccessToken: baseContext.account.accessToken,
      accountApiToken: baseContext.account.apiToken,
      siteApiKey: baseContext.site.apiKey,
      endpoint: 'messages',
      downstreamFormat: 'openai',
      modelName: 'gpt-5.3',
      status: 405,
      errorText: 'Method Not Allowed',
    });
    await flushUpstreamProtocolProfilePersistence();
    resetUpstreamEndpointRuntimeState();

    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
    );

    expect(order).toEqual(['responses']);
  });
});
