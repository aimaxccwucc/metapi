import { describe, expect, it } from 'vitest';
import { ensureSiteSchemaCompatibility, type SiteSchemaInspector } from './siteSchemaCompatibility.js';

function createInspector(
  dialect: SiteSchemaInspector['dialect'],
  options?: {
    hasSitesTable?: boolean;
    existingColumns?: string[];
  },
) {
  const executedSql: string[] = [];
  const hasSitesTable = options?.hasSitesTable ?? true;
  const existingColumns = new Set(options?.existingColumns ?? []);

  const inspector: SiteSchemaInspector = {
    dialect,
    async tableExists(table) {
      return table === 'sites' && hasSitesTable;
    },
    async columnExists(table, column) {
      return table === 'sites' && existingColumns.has(column);
    },
    async execute(sqlText) {
      executedSql.push(sqlText);
    },
  };

  return { inspector, executedSql };
}

describe('ensureSiteSchemaCompatibility', () => {
  it.each([
    {
      dialect: 'postgres' as const,
      expectedSql: [
        'ALTER TABLE "sites" ADD COLUMN "proxy_url" TEXT',
        'ALTER TABLE "sites" ADD COLUMN "use_system_proxy" BOOLEAN DEFAULT FALSE',
        'UPDATE "sites" SET "use_system_proxy" = FALSE WHERE "use_system_proxy" IS NULL',
        'ALTER TABLE "sites" ADD COLUMN "custom_headers" TEXT',
        'ALTER TABLE "sites" ADD COLUMN "external_checkin_url" TEXT',
        'ALTER TABLE "sites" ADD COLUMN "global_weight" DOUBLE PRECISION DEFAULT 1',
        'UPDATE "sites" SET "global_weight" = 1 WHERE "global_weight" IS NULL OR "global_weight" <= 0',
      ],
    },
    {
      dialect: 'mysql' as const,
      expectedSql: [
        'ALTER TABLE `sites` ADD COLUMN `proxy_url` TEXT NULL',
        'ALTER TABLE `sites` ADD COLUMN `use_system_proxy` BOOLEAN DEFAULT FALSE',
        'UPDATE `sites` SET `use_system_proxy` = FALSE WHERE `use_system_proxy` IS NULL',
        'ALTER TABLE `sites` ADD COLUMN `custom_headers` TEXT NULL',
        'ALTER TABLE `sites` ADD COLUMN `external_checkin_url` TEXT NULL',
        'ALTER TABLE `sites` ADD COLUMN `global_weight` DOUBLE DEFAULT 1',
        'UPDATE `sites` SET `global_weight` = 1 WHERE `global_weight` IS NULL OR `global_weight` <= 0',
      ],
    },
  ])('adds missing site proxy columns for $dialect', async ({ dialect, expectedSql }) => {
    const { inspector, executedSql } = createInspector(dialect);

    await ensureSiteSchemaCompatibility(inspector);

    expect(executedSql).toEqual(expectedSql);
  });

  it('skips schema changes when sites table does not exist', async () => {
    const { inspector, executedSql } = createInspector('postgres', { hasSitesTable: false });

    await ensureSiteSchemaCompatibility(inspector);

    expect(executedSql).toEqual([]);
  });
});
