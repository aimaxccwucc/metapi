import { describe, expect, it } from 'vitest';

import {
  ensureProxyFileSchemaCompatibility,
  type ProxyFileSchemaInspector,
} from './proxyFileSchemaCompatibility.js';

function createInspector(
  dialect: ProxyFileSchemaInspector['dialect'],
  options?: {
    hasTable?: boolean;
    existingColumns?: string[];
    columnTypes?: Record<string, string>;
    indexColumns?: Record<string, string[]>;
  },
) {
  const executedSql: string[] = [];
  const hasTable = options?.hasTable ?? false;
  const existingColumns = new Set(options?.existingColumns ?? []);
  const columnTypes = options?.columnTypes ?? {};
  const indexColumns = options?.indexColumns ?? {};

  const inspector: ProxyFileSchemaInspector = {
    dialect,
    async tableExists(table) {
      return table === 'proxy_files' && hasTable;
    },
    async columnExists(table, column) {
      return table === 'proxy_files' && existingColumns.has(column);
    },
    async getColumnType(table, column) {
      if (table !== 'proxy_files') return null;
      return columnTypes[column] ?? null;
    },
    async getIndexColumns(table, indexName) {
      if (table !== 'proxy_files') return null;
      return indexColumns[indexName] ?? null;
    },
    async execute(sqlText) {
      executedSql.push(sqlText);
    },
  };

  return { inspector, executedSql };
}

describe('ensureProxyFileSchemaCompatibility', () => {
  it.each([
    {
      dialect: 'postgres' as const,
      createPattern: /create table/i,
      uniqueIndexPattern: /create unique index/i,
      ownerIndexPattern: /owner_lookup_idx/i,
    },
    {
      dialect: 'mysql' as const,
      createPattern: /create table/i,
      uniqueIndexPattern: /create unique index/i,
      ownerIndexPattern: /owner_lookup_idx/i,
    },
    {
      dialect: 'sqlite' as const,
      createPattern: /create table/i,
      uniqueIndexPattern: /create unique index/i,
      ownerIndexPattern: /owner_lookup_idx/i,
    },
  ])('creates proxy_files table and indexes for $dialect', async ({ dialect, createPattern, uniqueIndexPattern, ownerIndexPattern }) => {
    const { inspector, executedSql } = createInspector(dialect);

    await ensureProxyFileSchemaCompatibility(inspector);

    expect(executedSql.some((sqlText) => createPattern.test(sqlText) && /proxy_files/i.test(sqlText))).toBe(true);
    expect(executedSql.some((sqlText) => uniqueIndexPattern.test(sqlText) && /proxy_files_public_id_unique/i.test(sqlText))).toBe(true);
    expect(executedSql.some((sqlText) => ownerIndexPattern.test(sqlText))).toBe(true);
  });

  it('adds missing columns on existing table before ensuring indexes', async () => {
    const { inspector, executedSql } = createInspector('postgres', {
      hasTable: true,
      existingColumns: ['public_id', 'owner_type', 'owner_id'],
    });

    await ensureProxyFileSchemaCompatibility(inspector);

    expect(executedSql.some((sqlText) => sqlText.includes('ADD COLUMN "purpose"'))).toBe(true);
    expect(executedSql.some((sqlText) => sqlText.includes('ADD COLUMN "filename"'))).toBe(true);
    expect(executedSql.some((sqlText) => sqlText.includes('ADD COLUMN "deleted_at"'))).toBe(true);
    expect(executedSql.some((sqlText) => sqlText.includes('proxy_files_public_id_unique'))).toBe(true);
  });

  it('rebuilds the mysql owner lookup index when legacy columns are incomplete', async () => {
    const { inspector, executedSql } = createInspector('mysql', {
      hasTable: true,
      existingColumns: ['public_id', 'owner_type', 'owner_id', 'filename', 'mime_type', 'purpose', 'byte_size', 'sha256', 'content_base64', 'created_at', 'updated_at', 'deleted_at'],
      columnTypes: {
        owner_type: 'text',
        owner_id: 'varchar(191)',
        deleted_at: 'datetime',
      },
      indexColumns: {
        proxy_files_owner_lookup_idx: ['owner_type', 'owner_id'],
      },
    });

    await ensureProxyFileSchemaCompatibility(inspector);

    expect(executedSql).toContain('DROP INDEX `proxy_files_owner_lookup_idx` ON `proxy_files`');
    expect(executedSql).toContain('CREATE INDEX `proxy_files_owner_lookup_idx` ON `proxy_files` (`owner_type`(191), `owner_id`, `deleted_at`)');
  });
});
