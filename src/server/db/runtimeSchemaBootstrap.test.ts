import { describe, expect, it } from 'vitest';
import {
  __runtimeSchemaBootstrapTestUtils,
  ensureRuntimeDatabaseSchema,
  type RuntimeSchemaClient,
  type RuntimeSchemaDialect,
} from './runtimeSchemaBootstrap.js';

function createStubClient(dialect: RuntimeSchemaDialect, executedSql: string[]): RuntimeSchemaClient {
  return {
    dialect,
    begin: async () => {},
    commit: async () => {},
    rollback: async () => {},
    execute: async (sqlText: string) => {
      executedSql.push(sqlText);
      return [];
    },
    queryScalar: async (sqlText: string, params: unknown[] = []) => {
      if (sqlText.includes('information_schema') || sqlText.includes('sqlite_master') || sqlText.includes('pragma_table_info')) {
        return 1;
      }
      if (params.length > 0) {
        return 1;
      }
      return 0;
    },
    close: async () => {},
  };
}

describe('runtime schema bootstrap', () => {
  it.each(['mysql', 'postgres'] as const)('loads generated bootstrap statements for %s', async (dialect) => {
    const executedSql: string[] = [];
    const expectedBootstrapSql = __runtimeSchemaBootstrapTestUtils.readGeneratedBootstrapStatements(dialect);

    await ensureRuntimeDatabaseSchema(createStubClient(dialect, executedSql));

    expect(executedSql.slice(0, expectedBootstrapSql.length)).toEqual(expectedBootstrapSql);
  });

  it('ignores duplicate mysql index errors when replaying bootstrap statements', async () => {
    const executedSql: string[] = [];
    const targetSql = 'CREATE UNIQUE INDEX `model_availability_account_model_unique` ON `model_availability` (`account_id`, `model_name`(191))';

    await ensureRuntimeDatabaseSchema({
      ...createStubClient('mysql', executedSql),
      execute: async (sqlText: string) => {
        executedSql.push(sqlText);
        if (sqlText === targetSql) {
          const error = new Error("Duplicate key name 'model_availability_account_model_unique'") as Error & { code?: string };
          error.code = 'ER_DUP_KEYNAME';
          throw error;
        }
        return [];
      },
    });

    expect(executedSql).toContain(targetSql);
  });

  it('replays the mysql bootstrap against an already-initialized schema', async () => {
    const executedSql: string[] = [];
    const createdStatements = new Set<string>();

    const mysqlClient = createStubClient('mysql', executedSql);
    mysqlClient.execute = async (sqlText: string) => {
      executedSql.push(sqlText);
      const normalized = sqlText.trim().toLowerCase();
      const createsSchemaObject = normalized.startsWith('create table if not exists')
        || normalized.startsWith('create index')
        || normalized.startsWith('create unique index');

      if (createsSchemaObject) {
        if (createdStatements.has(sqlText)) {
          const error = new Error(
            normalized.startsWith('create table')
              ? 'Table already exists'
              : 'Duplicate key name during bootstrap replay',
          ) as Error & { code?: string };
          error.code = normalized.startsWith('create table') ? 'ER_TABLE_EXISTS_ERROR' : 'ER_DUP_KEYNAME';
          throw error;
        }
        createdStatements.add(sqlText);
      }

      return [];
    };

    await ensureRuntimeDatabaseSchema(mysqlClient);
    await ensureRuntimeDatabaseSchema(mysqlClient);

    expect(executedSql.length).toBeGreaterThan(createdStatements.size);
    expect(createdStatements.size).toBeGreaterThan(0);
  });

  it('ignores postgres relation-already-exists errors when replaying bootstrap statements', async () => {
    const executedSql: string[] = [];
    const targetSql = 'CREATE UNIQUE INDEX "model_availability_account_model_unique" ON "model_availability" ("account_id", "model_name")';

    await ensureRuntimeDatabaseSchema({
      ...createStubClient('postgres', executedSql),
      execute: async (sqlText: string) => {
        executedSql.push(sqlText);
        if (sqlText === targetSql) {
          const error = new Error('relation "model_availability_account_model_unique" already exists') as Error & { code?: string };
          error.code = '42P07';
          throw error;
        }
        return [];
      },
    });

    expect(executedSql).toContain(targetSql);
  });
});
