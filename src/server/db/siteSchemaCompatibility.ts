export type SiteSchemaDialect = 'sqlite' | 'mysql' | 'postgres';

export interface SiteSchemaInspector {
  dialect: SiteSchemaDialect;
  tableExists(table: string): Promise<boolean>;
  columnExists(table: string, column: string): Promise<boolean>;
  execute(sqlText: string): Promise<void>;
}

type SiteColumnCompatibilitySpec = {
  column: string;
  addSql: Record<SiteSchemaDialect, string>;
  normalizeSql?: Record<SiteSchemaDialect, string>;
};

const SITE_COLUMN_COMPATIBILITY_SPECS: SiteColumnCompatibilitySpec[] = [
  {
    column: 'proxy_url',
    addSql: {
      sqlite: 'ALTER TABLE sites ADD COLUMN proxy_url text;',
      mysql: 'ALTER TABLE `sites` ADD COLUMN `proxy_url` TEXT NULL',
      postgres: 'ALTER TABLE "sites" ADD COLUMN "proxy_url" TEXT',
    },
  },
  {
    column: 'use_system_proxy',
    addSql: {
      sqlite: 'ALTER TABLE sites ADD COLUMN use_system_proxy integer DEFAULT 0;',
      mysql: 'ALTER TABLE `sites` ADD COLUMN `use_system_proxy` BOOLEAN DEFAULT FALSE',
      postgres: 'ALTER TABLE "sites" ADD COLUMN "use_system_proxy" BOOLEAN DEFAULT FALSE',
    },
    normalizeSql: {
      sqlite: 'UPDATE sites SET use_system_proxy = 0 WHERE use_system_proxy IS NULL;',
      mysql: 'UPDATE `sites` SET `use_system_proxy` = FALSE WHERE `use_system_proxy` IS NULL',
      postgres: 'UPDATE "sites" SET "use_system_proxy" = FALSE WHERE "use_system_proxy" IS NULL',
    },
  },
  {
    column: 'custom_headers',
    addSql: {
      sqlite: 'ALTER TABLE sites ADD COLUMN custom_headers text;',
      mysql: 'ALTER TABLE `sites` ADD COLUMN `custom_headers` TEXT NULL',
      postgres: 'ALTER TABLE "sites" ADD COLUMN "custom_headers" TEXT',
    },
  },
  {
    column: 'external_checkin_url',
    addSql: {
      sqlite: 'ALTER TABLE sites ADD COLUMN external_checkin_url text;',
      mysql: 'ALTER TABLE `sites` ADD COLUMN `external_checkin_url` TEXT NULL',
      postgres: 'ALTER TABLE "sites" ADD COLUMN "external_checkin_url" TEXT',
    },
  },
  {
    column: 'global_weight',
    addSql: {
      sqlite: 'ALTER TABLE sites ADD COLUMN global_weight real DEFAULT 1;',
      mysql: 'ALTER TABLE `sites` ADD COLUMN `global_weight` DOUBLE DEFAULT 1',
      postgres: 'ALTER TABLE "sites" ADD COLUMN "global_weight" DOUBLE PRECISION DEFAULT 1',
    },
    normalizeSql: {
      sqlite: 'UPDATE sites SET global_weight = 1 WHERE global_weight IS NULL OR global_weight <= 0;',
      mysql: 'UPDATE `sites` SET `global_weight` = 1 WHERE `global_weight` IS NULL OR `global_weight` <= 0',
      postgres: 'UPDATE "sites" SET "global_weight" = 1 WHERE "global_weight" IS NULL OR "global_weight" <= 0',
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

async function executeAddColumn(inspector: SiteSchemaInspector, sqlText: string): Promise<void> {
  try {
    await inspector.execute(sqlText);
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

export async function ensureSiteSchemaCompatibility(inspector: SiteSchemaInspector): Promise<void> {
  const hasSitesTable = await inspector.tableExists('sites');
  if (!hasSitesTable) {
    return;
  }

  for (const spec of SITE_COLUMN_COMPATIBILITY_SPECS) {
    const hasColumn = await inspector.columnExists('sites', spec.column);
    if (!hasColumn) {
      await executeAddColumn(inspector, spec.addSql[inspector.dialect]);
    }

    if (spec.normalizeSql) {
      await inspector.execute(spec.normalizeSql[inspector.dialect]);
    }
  }
}
