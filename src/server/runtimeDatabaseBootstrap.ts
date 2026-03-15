import {
  bootstrapRuntimeDatabaseSchema,
  createRuntimeSchemaClient,
  type RuntimeSchemaDialect,
} from './db/runtimeSchemaBootstrap.js';

let sqliteMigrationsBootstrapped = false;

export async function runSqliteRuntimeMigrations(): Promise<void> {
  const migrateModule = await import('./db/migrate.js');
  if (sqliteMigrationsBootstrapped) {
    migrateModule.runSqliteMigrations();
    return;
  }
  sqliteMigrationsBootstrapped = true;
}

type EnsureRuntimeDatabaseReadyInput = {
  dialect: RuntimeSchemaDialect;
  connectionString?: string;
  ssl?: boolean;
  runSqliteRuntimeMigrations?: () => Promise<void>;
  ensureExternalRuntimeSchema?: () => Promise<void>;
  externalRuntimeSchemaAlreadyInitialized?: () => Promise<boolean>;
};

export async function ensureRuntimeDatabaseReady(input: EnsureRuntimeDatabaseReadyInput): Promise<void> {
  if (input.dialect === 'sqlite') {
    const runSqlite = input.runSqliteRuntimeMigrations || runSqliteRuntimeMigrations;
    await runSqlite();
    return;
  }

  const externalRuntimeSchemaAlreadyInitialized = input.externalRuntimeSchemaAlreadyInitialized || (async () => {
    const connectionString = (input.connectionString || '').trim();
    if (!connectionString) {
      throw new Error(`DB_URL is required when DB_TYPE=${input.dialect}`);
    }

    const client = await createRuntimeSchemaClient({
      dialect: input.dialect,
      connectionString,
      ssl: !!input.ssl,
    });
    try {
      if (input.dialect === 'mysql') {
        return (await client.queryScalar(
          'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
          ['settings'],
        )) > 0;
      }
      return (await client.queryScalar(
        'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
        ['settings'],
      )) > 0;
    } finally {
      await client.close();
    }
  });

  if (await externalRuntimeSchemaAlreadyInitialized()) {
    return;
  }

  const ensureExternal = input.ensureExternalRuntimeSchema || (async () => {
    const connectionString = (input.connectionString || '').trim();
    if (!connectionString) {
      throw new Error(`DB_URL is required when DB_TYPE=${input.dialect}`);
    }
    await bootstrapRuntimeDatabaseSchema({
      dialect: input.dialect,
      connectionString,
      ssl: !!input.ssl,
    });
  });

  await ensureExternal();
}

export const __runtimeDatabaseBootstrapTestUtils = {
  resetSqliteMigrationsBootstrapped() {
    sqliteMigrationsBootstrapped = false;
  },
};
