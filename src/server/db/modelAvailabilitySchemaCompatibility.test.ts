import { describe, expect, it } from 'vitest';

import {
  ensureModelAvailabilitySchemaCompatibility,
  type ModelAvailabilitySchemaInspector,
} from './modelAvailabilitySchemaCompatibility.js';

function createInspector(
  dialect: ModelAvailabilitySchemaInspector['dialect'],
  options?: {
    hasTable?: boolean;
    existingColumns?: string[];
  },
) {
  const executedSql: string[] = [];
  const hasTable = options?.hasTable ?? true;
  const existingColumns = new Set(options?.existingColumns ?? []);

  const inspector: ModelAvailabilitySchemaInspector = {
    dialect,
    async tableExists(table) {
      return table === 'model_availability' && hasTable;
    },
    async columnExists(table, column) {
      return table === 'model_availability' && existingColumns.has(column);
    },
    async execute(sqlText) {
      executedSql.push(sqlText);
    },
  };

  return { inspector, executedSql };
}

describe('ensureModelAvailabilitySchemaCompatibility', () => {
  it.each([
    {
      dialect: 'sqlite' as const,
      expectedSql: [
        'ALTER TABLE model_availability ADD COLUMN is_manual integer DEFAULT 0;',
        'UPDATE model_availability SET is_manual = 0 WHERE is_manual IS NULL;',
      ],
    },
    {
      dialect: 'mysql' as const,
      expectedSql: [
        'ALTER TABLE `model_availability` ADD COLUMN `is_manual` BOOLEAN DEFAULT FALSE',
        'UPDATE `model_availability` SET `is_manual` = FALSE WHERE `is_manual` IS NULL',
      ],
    },
    {
      dialect: 'postgres' as const,
      expectedSql: [
        'ALTER TABLE "model_availability" ADD COLUMN "is_manual" BOOLEAN DEFAULT FALSE',
        'UPDATE "model_availability" SET "is_manual" = FALSE WHERE "is_manual" IS NULL',
      ],
    },
  ])('adds missing is_manual column for $dialect', async ({ dialect, expectedSql }) => {
    const { inspector, executedSql } = createInspector(dialect);

    await ensureModelAvailabilitySchemaCompatibility(inspector);

    expect(executedSql).toEqual(expectedSql);
  });

  it('only normalizes existing column values when the column already exists', async () => {
    const { inspector, executedSql } = createInspector('mysql', {
      existingColumns: ['is_manual'],
    });

    await ensureModelAvailabilitySchemaCompatibility(inspector);

    expect(executedSql).toEqual([
      'UPDATE `model_availability` SET `is_manual` = FALSE WHERE `is_manual` IS NULL',
    ]);
  });

  it('skips when model_availability table is missing', async () => {
    const { inspector, executedSql } = createInspector('postgres', {
      hasTable: false,
    });

    await ensureModelAvailabilitySchemaCompatibility(inspector);

    expect(executedSql).toEqual([]);
  });
});
