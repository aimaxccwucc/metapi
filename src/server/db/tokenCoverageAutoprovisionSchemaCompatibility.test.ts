import { describe, expect, it } from 'vitest';
import {
  ensureTokenCoverageAutoprovisionSchemaCompatibility,
  type TokenCoverageAutoprovisionSchemaInspector,
} from './tokenCoverageAutoprovisionSchemaCompatibility.js';

function createInspector(
  dialect: TokenCoverageAutoprovisionSchemaInspector['dialect'],
  options?: {
    existingTable?: boolean;
    duplicateIndexNames?: string[];
  },
) {
  const executedSql: string[] = [];
  const existingTable = options?.existingTable ?? false;
  const duplicateIndexNames = new Set(options?.duplicateIndexNames ?? []);

  const inspector: TokenCoverageAutoprovisionSchemaInspector = {
    dialect,
    async tableExists(table) {
      return table === 'token_coverage_autoprovision_states' ? existingTable : false;
    },
    async columnExists() {
      return false;
    },
    async execute(sqlText) {
      executedSql.push(sqlText);
      if (dialect !== 'mysql') return;
      const matched = sqlText.match(/INDEX [`"]?([a-z0-9_]+)[`"]?/i);
      const indexName = matched?.[1] || '';
      if (!duplicateIndexNames.has(indexName)) return;
      const error = new Error(`Duplicate key name '${indexName}'`) as Error & { code?: string };
      error.code = 'ER_DUP_KEYNAME';
      throw error;
    },
  };

  return { inspector, executedSql };
}

describe('ensureTokenCoverageAutoprovisionSchemaCompatibility', () => {
  it('ignores mysql duplicate index creation errors during compatibility bootstrap', async () => {
    const { inspector, executedSql } = createInspector('mysql', {
      existingTable: true,
      duplicateIndexNames: [
        'token_coverage_autoprovision_states_account_model_group_unique',
        'token_coverage_autoprovision_states_status_cooldown_idx',
      ],
    });

    await expect(ensureTokenCoverageAutoprovisionSchemaCompatibility(inspector)).resolves.toBeUndefined();
    expect(executedSql).toHaveLength(3);
  });

  it('creates table and indexes for sqlite when table missing', async () => {
    const { inspector, executedSql } = createInspector('sqlite', {
      existingTable: false,
    });

    await ensureTokenCoverageAutoprovisionSchemaCompatibility(inspector);
    expect(executedSql[0]).toContain('CREATE TABLE IF NOT EXISTS token_coverage_autoprovision_states');
    expect(executedSql).toHaveLength(4);
  });
});
