export type ModelAvailabilitySchemaDialect = 'sqlite' | 'mysql' | 'postgres';

export interface ModelAvailabilitySchemaInspector {
  dialect: ModelAvailabilitySchemaDialect;
  tableExists(table: string): Promise<boolean>;
  columnExists(table: string, column: string): Promise<boolean>;
  execute(sqlText: string): Promise<void>;
}

type ModelAvailabilityColumnCompatibilitySpec = {
  table: 'model_availability';
  column: string;
  addSql: Record<ModelAvailabilitySchemaDialect, string>;
  normalizeSql?: Record<ModelAvailabilitySchemaDialect, string>;
};

const MODEL_AVAILABILITY_COLUMN_COMPATIBILITY_SPECS: ModelAvailabilityColumnCompatibilitySpec[] = [
  {
    table: 'model_availability',
    column: 'is_manual',
    addSql: {
      sqlite: 'ALTER TABLE model_availability ADD COLUMN is_manual integer DEFAULT 0;',
      mysql: 'ALTER TABLE `model_availability` ADD COLUMN `is_manual` BOOLEAN DEFAULT FALSE',
      postgres: 'ALTER TABLE "model_availability" ADD COLUMN "is_manual" BOOLEAN DEFAULT FALSE',
    },
    normalizeSql: {
      sqlite: 'UPDATE model_availability SET is_manual = 0 WHERE is_manual IS NULL;',
      mysql: 'UPDATE `model_availability` SET `is_manual` = FALSE WHERE `is_manual` IS NULL',
      postgres: 'UPDATE "model_availability" SET "is_manual" = FALSE WHERE "is_manual" IS NULL',
    },
  },
];

function normalizeSchemaErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message?: unknown }).message || '');
  }
  return String(error || '');
}

function isDuplicateColumnError(error: unknown): boolean {
  const lowered = normalizeSchemaErrorMessage(error).toLowerCase();
  return lowered.includes('duplicate column')
    || lowered.includes('already exists')
    || lowered.includes('duplicate column name');
}

async function executeAddColumn(inspector: ModelAvailabilitySchemaInspector, sqlText: string): Promise<void> {
  try {
    await inspector.execute(sqlText);
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

export async function ensureModelAvailabilitySchemaCompatibility(inspector: ModelAvailabilitySchemaInspector): Promise<void> {
  for (const spec of MODEL_AVAILABILITY_COLUMN_COMPATIBILITY_SPECS) {
    const hasTable = await inspector.tableExists(spec.table);
    if (!hasTable) {
      continue;
    }

    const hasColumn = await inspector.columnExists(spec.table, spec.column);
    if (!hasColumn) {
      await executeAddColumn(inspector, spec.addSql[inspector.dialect]);
    }

    if (spec.normalizeSql) {
      await inspector.execute(spec.normalizeSql[inspector.dialect]);
    }
  }
}
