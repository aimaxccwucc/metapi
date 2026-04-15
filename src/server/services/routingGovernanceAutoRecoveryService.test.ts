import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type RoutingGovernanceModule = typeof import('./routingGovernanceService.js');
type AutoRecoveryModule = typeof import('./routingGovernanceAutoRecoveryService.js');

describe('routingGovernanceAutoRecoveryService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let upsertRoutingGovernanceState: RoutingGovernanceModule['upsertRoutingGovernanceState'];
  let executeRoutingGovernanceAutoRecoveryPass: AutoRecoveryModule['executeRoutingGovernanceAutoRecoveryPass'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-governance-auto-recovery-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const governanceModule = await import('./routingGovernanceService.js');
    const autoRecoveryModule = await import('./routingGovernanceAutoRecoveryService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    upsertRoutingGovernanceState = governanceModule.upsertRoutingGovernanceState;
    executeRoutingGovernanceAutoRecoveryPass = autoRecoveryModule.executeRoutingGovernanceAutoRecoveryPass;
  });

  beforeEach(async () => {
    await db.delete(schema.routingGovernanceStates).run();
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  it('auto-clears expired rate-limit governance instead of leaving it in probing', async () => {
    await upsertRoutingGovernanceState({
      subjectType: 'account',
      subjectId: 42,
      state: 'suppressed',
      reasonCode: 'rate_limit',
      reasonDetail: 'retry later',
      suppressUntil: '2000-01-01T00:00:00.000Z',
      probeAfter: '2000-01-01T00:00:00.000Z',
    });

    const result = await executeRoutingGovernanceAutoRecoveryPass();
    expect(result.promotedToProbing).toBe(1);
    expect(result.restored).toBe(1);

    const remaining = await db.select().from(schema.routingGovernanceStates).all();
    expect(remaining).toHaveLength(0);
  });

  it('promotes model_unsupported governance to probing for active reprobe', async () => {
    await upsertRoutingGovernanceState({
      subjectType: 'token',
      subjectId: 7,
      modelName: 'gpt-4.1',
      state: 'suppressed',
      reasonCode: 'model_unsupported',
      reasonDetail: 'runtime failure from live traffic',
      suppressUntil: '2000-01-01T00:00:00.000Z',
      probeAfter: '2000-01-01T00:00:00.000Z',
    });

    const result = await executeRoutingGovernanceAutoRecoveryPass();
    // model_unsupported now gets promoted to probing for active reprobe
    expect(result.promotedToProbing).toBe(1);
    // No account/token/site in DB for subjectId=7, probe context is null,
    // handleProbeBasedRecovery returns false (keeps suppressed with extended wait)
    expect(result.restored).toBe(0);

    const remaining = await db.select().from(schema.routingGovernanceStates).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      reasonCode: 'model_unsupported',
      state: 'suppressed',
      lastProbeStatus: 'skipped',
    });
  });

  it('passively releases invalid-channel governance after expiry without active reprobe', async () => {
    await upsertRoutingGovernanceState({
      subjectType: 'channel',
      subjectId: 9,
      modelName: 'gpt-5.4',
      state: 'suppressed',
      reasonCode: 'invalid_channel',
      reasonDetail: 'openai_error bad_response_status_code',
      suppressUntil: '2000-01-01T00:00:00.000Z',
      probeAfter: '2000-01-01T00:00:00.000Z',
    });

    const result = await executeRoutingGovernanceAutoRecoveryPass();
    expect(result.promotedToProbing).toBe(0);
    expect(result.restored).toBe(1);

    const remaining = await db.select().from(schema.routingGovernanceStates).all();
    expect(remaining).toHaveLength(0);
  });

  it('keeps manual probe governance in recovery flow instead of passively releasing it', { timeout: 30_000 }, async () => {
    await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4.1',
      probePolicy: 'manual',
      enabled: true,
    }).run();
    await db.insert(schema.sites).values({
      id: 1,
      name: 'manual-site',
      url: 'https://manual-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).run();
    await db.insert(schema.accounts).values({
      id: 1,
      siteId: 1,
      username: 'manual-user',
      accessToken: 'manual-access',
      status: 'active',
    }).run();
    await db.insert(schema.accountTokens).values({
      id: 8,
      accountId: 1,
      name: 'manual-token',
      token: 'sk-manual-token',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).run();
    await db.insert(schema.routeChannels).values({
      routeId: 1,
      accountId: 1,
      tokenId: 8,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    await upsertRoutingGovernanceState({
      subjectType: 'token',
      subjectId: 8,
      modelName: 'gpt-4.1',
      state: 'suppressed',
      reasonCode: 'model_unsupported',
      reasonDetail: '[manual_route_probe] model gpt-4.1 not found',
      suppressUntil: '2000-01-01T00:00:00.000Z',
      probeAfter: '2000-01-01T00:00:00.000Z',
    });

    const result = await executeRoutingGovernanceAutoRecoveryPass();
    expect(result.promotedToProbing).toBe(1);
    expect(result.restored).toBe(0);

    const remaining = await db.select().from(schema.routingGovernanceStates).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      subjectType: 'token',
      subjectId: 8,
      reasonCode: 'model_unsupported',
      state: 'suppressed',
    });
  });
});
