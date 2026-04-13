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

type SiteTableCompatibilitySpec = {
  table: string;
  createSql: Record<SiteSchemaDialect, string>;
  postCreateSql?: Record<SiteSchemaDialect, string[]>;
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
  {
    column: 'health_status',
    addSql: {
      sqlite: "ALTER TABLE sites ADD COLUMN health_status text NOT NULL DEFAULT 'unknown';",
      mysql: "ALTER TABLE `sites` ADD COLUMN `health_status` TEXT NOT NULL DEFAULT 'unknown'",
      postgres: "ALTER TABLE \"sites\" ADD COLUMN \"health_status\" TEXT NOT NULL DEFAULT 'unknown'",
    },
    normalizeSql: {
      sqlite: "UPDATE sites SET health_status = 'unknown' WHERE health_status IS NULL OR trim(health_status) = '';",
      mysql: "UPDATE `sites` SET `health_status` = 'unknown' WHERE `health_status` IS NULL OR TRIM(`health_status`) = ''",
      postgres: "UPDATE \"sites\" SET \"health_status\" = 'unknown' WHERE \"health_status\" IS NULL OR btrim(\"health_status\") = ''",
    },
  },
  {
    column: 'health_reason',
    addSql: {
      sqlite: 'ALTER TABLE sites ADD COLUMN health_reason text;',
      mysql: 'ALTER TABLE `sites` ADD COLUMN `health_reason` TEXT NULL',
      postgres: 'ALTER TABLE "sites" ADD COLUMN "health_reason" TEXT',
    },
  },
  {
    column: 'health_checked_at',
    addSql: {
      sqlite: 'ALTER TABLE sites ADD COLUMN health_checked_at text;',
      mysql: 'ALTER TABLE `sites` ADD COLUMN `health_checked_at` DATETIME NULL',
      postgres: 'ALTER TABLE "sites" ADD COLUMN "health_checked_at" TIMESTAMP',
    },
  },
  {
    column: 'flaresolverr_url',
    addSql: {
      sqlite: 'ALTER TABLE sites ADD COLUMN flaresolverr_url text;',
      mysql: 'ALTER TABLE `sites` ADD COLUMN `flaresolverr_url` TEXT NULL',
      postgres: 'ALTER TABLE "sites" ADD COLUMN "flaresolverr_url" TEXT',
    },
  },
];

const SITE_TABLE_COMPATIBILITY_SPECS: SiteTableCompatibilitySpec[] = [
  {
    table: 'site_disabled_models',
    createSql: {
      sqlite: 'CREATE TABLE IF NOT EXISTS site_disabled_models (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, site_id integer NOT NULL REFERENCES sites(id) ON DELETE cascade, model_name text NOT NULL, created_at text DEFAULT (datetime(\'now\')));',
      mysql: 'CREATE TABLE IF NOT EXISTS `site_disabled_models` (`id` INT AUTO_INCREMENT PRIMARY KEY, `site_id` INT NOT NULL, `model_name` VARCHAR(191) NOT NULL, `created_at` TEXT NULL, CONSTRAINT `site_disabled_models_site_fk` FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE)',
      postgres: 'CREATE TABLE IF NOT EXISTS "site_disabled_models" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "site_id" INTEGER NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE, "model_name" TEXT NOT NULL, "created_at" TEXT)',
    },
    postCreateSql: {
      sqlite: [
        'CREATE UNIQUE INDEX IF NOT EXISTS site_disabled_models_site_model_unique ON site_disabled_models (site_id, model_name);',
        'CREATE INDEX IF NOT EXISTS site_disabled_models_site_id_idx ON site_disabled_models (site_id);',
      ],
      mysql: [
        'CREATE UNIQUE INDEX `site_disabled_models_site_model_unique` ON `site_disabled_models` (`site_id`, `model_name`(191))',
        'CREATE INDEX `site_disabled_models_site_id_idx` ON `site_disabled_models` (`site_id`)',
      ],
      postgres: [
        'CREATE UNIQUE INDEX IF NOT EXISTS "site_disabled_models_site_model_unique" ON "site_disabled_models" ("site_id", "model_name")',
        'CREATE INDEX IF NOT EXISTS "site_disabled_models_site_id_idx" ON "site_disabled_models" ("site_id")',
      ],
    },
  },
  {
    table: 'sites_health_status_index_marker',
    createSql: {
      sqlite: 'SELECT 1;',
      mysql: 'SELECT 1',
      postgres: 'SELECT 1',
    },
    postCreateSql: {
      sqlite: [
        'CREATE INDEX IF NOT EXISTS sites_health_status_idx ON sites (health_status);',
      ],
      mysql: [
        'CREATE INDEX `sites_health_status_idx` ON `sites` (`health_status`(191))',
      ],
      postgres: [
        'CREATE INDEX IF NOT EXISTS "sites_health_status_idx" ON "sites" ("health_status")',
      ],
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

function isExistingSchemaObjectError(error: unknown): boolean {
  const lowered = normalizeSchemaErrorMessage(error).toLowerCase();
  return lowered.includes('duplicate column')
    || lowered.includes('already exists')
    || lowered.includes('duplicate column name')
    || lowered.includes('duplicate key name')
    || (lowered.includes('relation') && lowered.includes('already exists'));
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

async function executeCreateSchemaObject(inspector: SiteSchemaInspector, sqlText: string): Promise<void> {
  try {
    await inspector.execute(sqlText);
  } catch (error) {
    if (!isExistingSchemaObjectError(error)) {
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

  for (const spec of SITE_TABLE_COMPATIBILITY_SPECS) {
    if (spec.table === 'sites_health_status_index_marker') {
      for (const sqlText of spec.postCreateSql?.[inspector.dialect] ?? []) {
        await executeCreateSchemaObject(inspector, sqlText);
      }
      continue;
    }
    const hasTable = await inspector.tableExists(spec.table);
    if (!hasTable) {
      await executeCreateSchemaObject(inspector, spec.createSql[inspector.dialect]);
    }

    for (const sqlText of spec.postCreateSql?.[inspector.dialect] ?? []) {
      await executeCreateSchemaObject(inspector, sqlText);
    }
  }
}
