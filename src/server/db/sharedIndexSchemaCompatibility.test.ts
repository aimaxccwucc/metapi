import { describe, expect, it } from 'vitest';
import { ensureSharedIndexSchemaCompatibility, type SharedIndexSchemaInspector } from './sharedIndexSchemaCompatibility.js';

function createInspector(
  dialect: SharedIndexSchemaInspector['dialect'],
  options?: {
    existingTables?: string[];
  },
) {
  const executedSql: string[] = [];
  const existingTables = new Set(options?.existingTables ?? []);

  const inspector: SharedIndexSchemaInspector = {
    dialect,
    async tableExists(table) {
      return existingTables.has(table);
    },
    async execute(sqlText) {
      executedSql.push(sqlText);
    },
  };

  return { inspector, executedSql };
}

describe('ensureSharedIndexSchemaCompatibility', () => {
  it.each([
    {
      dialect: 'sqlite' as const,
      expectedSql: [
        'CREATE UNIQUE INDEX IF NOT EXISTS model_availability_account_model_unique ON model_availability (account_id, model_name);',
        'CREATE INDEX IF NOT EXISTS proxy_logs_status_created_at_idx ON proxy_logs (status, created_at);',
        'CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at);',
      ],
    },
    {
      dialect: 'mysql' as const,
      expectedSql: [
        'CREATE UNIQUE INDEX `model_availability_account_model_unique` ON `model_availability` (`account_id`, `model_name`(191))',
        'CREATE INDEX `proxy_logs_status_created_at_idx` ON `proxy_logs` (`status`, `created_at`(191))',
        'CREATE INDEX `events_created_at_idx` ON `events` (`created_at`(191))',
      ],
    },
    {
      dialect: 'postgres' as const,
      expectedSql: [
        'CREATE UNIQUE INDEX IF NOT EXISTS "model_availability_account_model_unique" ON "model_availability" ("account_id", "model_name")',
        'CREATE INDEX IF NOT EXISTS "proxy_logs_status_created_at_idx" ON "proxy_logs" ("status", "created_at")',
        'CREATE INDEX IF NOT EXISTS "events_created_at_idx" ON "events" ("created_at")',
      ],
    },
  ])('creates shared indexes for $dialect', async ({ dialect, expectedSql }) => {
    const { inspector, executedSql } = createInspector(dialect, {
      existingTables: [
        'sites',
        'accounts',
        'account_tokens',
        'checkin_logs',
        'model_availability',
        'token_model_availability',
        'token_routes',
        'route_channels',
        'proxy_logs',
        'proxy_video_tasks',
        'downstream_api_keys',
        'events',
      ],
    });

    await ensureSharedIndexSchemaCompatibility(inspector);

    for (const sqlText of expectedSql) {
      expect(executedSql).toContain(sqlText);
    }
  });

  it('skips indexes for tables that do not exist', async () => {
    const { inspector, executedSql } = createInspector('postgres', {
      existingTables: ['sites'],
    });

    await ensureSharedIndexSchemaCompatibility(inspector);

    expect(executedSql).toEqual([
      'CREATE INDEX IF NOT EXISTS "sites_status_idx" ON "sites" ("status")',
    ]);
  });
});
