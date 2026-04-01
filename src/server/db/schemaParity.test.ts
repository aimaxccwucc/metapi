import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SchemaContract } from './schemaContract.js';
import { SHARED_INDEX_COMPATIBILITY_SPECS } from './sharedIndexSchemaCompatibility.js';

const dbDir = dirname(fileURLToPath(import.meta.url));
const generatedDir = resolve(dbDir, 'generated');
const supportPaths = [
  resolve(dbDir, 'runtimeSchemaBootstrap.ts'),
  resolve(dbDir, 'siteSchemaCompatibility.ts'),
  resolve(dbDir, 'routeGroupingSchemaCompatibility.ts'),
  resolve(dbDir, 'proxyFileSchemaCompatibility.ts'),
  resolve(dbDir, 'accountTokenSchemaCompatibility.ts'),
  resolve(dbDir, 'sharedIndexSchemaCompatibility.ts'),
];
const schemaContractPath = resolve(generatedDir, 'schemaContract.json');

function extractAllMatches(content: string, pattern: RegExp): string[] {
  return Array.from(content.matchAll(pattern), (match) => match[1]);
}

describe('database schema parity', () => {
  it('keeps generated schema artifacts present', () => {
    const artifactPaths = [
      schemaContractPath,
      resolve(generatedDir, 'mysql.bootstrap.sql'),
      resolve(generatedDir, 'mysql.upgrade.sql'),
      resolve(generatedDir, 'postgres.bootstrap.sql'),
      resolve(generatedDir, 'postgres.upgrade.sql'),
    ];

    for (const artifactPath of artifactPaths) {
      expect(existsSync(artifactPath), artifactPath).toBe(true);
      expect(readFileSync(artifactPath, 'utf8').trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps runtime support modules scoped to contract-defined tables and indexes', () => {
    const contract = JSON.parse(readFileSync(schemaContractPath, 'utf8')) as SchemaContract;
    const supportContent = supportPaths
      .map((filePath) => readFileSync(filePath, 'utf8'))
      .join('\n');

    const knownTables = new Set(Object.keys(contract.tables));
    const knownIndexes = new Set([
      ...contract.indexes.map((index) => index.name),
      ...contract.uniques.map((unique) => unique.name),
    ]);

    const supportTables = extractAllMatches(
      supportContent,
      /(?:CREATE TABLE IF NOT EXISTS|ALTER TABLE|INSERT INTO)\s+["`]?([a-z_][a-z0-9_]*)["`]?/gi,
    );
    const supportIndexes = extractAllMatches(
      supportContent,
      /(?:CREATE UNIQUE INDEX(?: IF NOT EXISTS)?|CREATE INDEX(?: IF NOT EXISTS)?|indexName:\s*')["`]?([a-z_][a-z0-9_]*)/gi,
    );

    const unknownTables = [...new Set(supportTables)].filter((tableName) => !knownTables.has(tableName)).sort();
    const unknownIndexes = [...new Set(supportIndexes)].filter((indexName) => !knownIndexes.has(indexName)).sort();

    expect(unknownTables).toEqual([]);
    expect(unknownIndexes).toEqual([]);
  });

  it('does not duplicate contract-defined indexes inside shared index compatibility specs', () => {
    const contract = JSON.parse(readFileSync(schemaContractPath, 'utf8')) as SchemaContract;
    const contractIndexNames = new Set([
      ...contract.indexes.map((index) => index.name),
      ...contract.uniques.map((unique) => unique.name),
    ]);

    const duplicatedSpecs = SHARED_INDEX_COMPATIBILITY_SPECS
      .map((spec) => spec.indexName)
      .filter((indexName) => contractIndexNames.has(indexName));

    expect(duplicatedSpecs).toEqual([]);
  });

  it('keeps proxy_logs downstream api key schema in the generated contract artifacts', () => {
    const contract = JSON.parse(readFileSync(schemaContractPath, 'utf8')) as SchemaContract;
    const mysqlBootstrap = readFileSync(resolve(generatedDir, 'mysql.bootstrap.sql'), 'utf8');
    const postgresBootstrap = readFileSync(resolve(generatedDir, 'postgres.bootstrap.sql'), 'utf8');

    expect(contract.tables.proxy_logs?.columns.downstream_api_key_id?.logicalType).toBe('integer');
    expect(contract.tables.proxy_logs?.columns.client_app_id?.logicalType).toBe('text');
    expect(contract.tables.proxy_logs?.columns.client_family?.logicalType).toBe('text');
    expect(contract.indexes.some((index) => index.name === 'proxy_logs_downstream_api_key_created_at_idx')).toBe(true);
    expect(contract.indexes.some((index) => index.name === 'proxy_logs_client_app_id_created_at_idx')).toBe(true);
    expect(contract.indexes.some((index) => index.name === 'proxy_logs_client_family_created_at_idx')).toBe(true);
    expect(mysqlBootstrap).toContain('`downstream_api_key_id`');
    expect(mysqlBootstrap).toContain('`proxy_logs_downstream_api_key_created_at_idx`');
    expect(mysqlBootstrap).toContain('`client_app_id`');
    expect(mysqlBootstrap).toContain('`proxy_logs_client_app_id_created_at_idx`');
    expect(postgresBootstrap).toContain('"downstream_api_key_id"');
    expect(postgresBootstrap).toContain('"proxy_logs_downstream_api_key_created_at_idx"');
    expect(postgresBootstrap).toContain('"client_app_id"');
    expect(postgresBootstrap).toContain('"proxy_logs_client_app_id_created_at_idx"');
  });

  it('keeps response_cache schema and indexes in generated contract artifacts', () => {
    const contract = JSON.parse(readFileSync(schemaContractPath, 'utf8')) as SchemaContract;
    const mysqlBootstrap = readFileSync(resolve(generatedDir, 'mysql.bootstrap.sql'), 'utf8');
    const mysqlUpgrade = readFileSync(resolve(generatedDir, 'mysql.upgrade.sql'), 'utf8');
    const postgresBootstrap = readFileSync(resolve(generatedDir, 'postgres.bootstrap.sql'), 'utf8');
    const postgresUpgrade = readFileSync(resolve(generatedDir, 'postgres.upgrade.sql'), 'utf8');

    expect(contract.tables.response_cache?.columns.estimated_cost?.logicalType).toBe('real');
    expect(contract.tables.response_cache?.columns.hit_count?.logicalType).toBe('integer');
    expect(contract.tables.routing_governance_states?.columns.reason_code?.logicalType).toBe('text');
    expect(contract.tables.token_routes?.columns.probe_policy?.logicalType).toBe('text');
    expect(contract.indexes.some((index) => index.name === 'response_cache_expires_at_idx')).toBe(true);
    expect(contract.indexes.some((index) => index.name === 'response_cache_model_idx')).toBe(true);
    expect(contract.uniques.some((unique) => unique.name === 'response_cache_key_idx')).toBe(true);
    expect(contract.uniques.some((unique) => unique.name === 'routing_governance_states_subject_scope_unique')).toBe(true);
    expect(mysqlBootstrap).toContain('CREATE TABLE IF NOT EXISTS `response_cache`');
    expect(mysqlBootstrap).toContain('`estimated_cost` DOUBLE DEFAULT 0');
    expect(mysqlBootstrap).toContain('CREATE UNIQUE INDEX `response_cache_key_idx`');
    expect(mysqlBootstrap).toContain('CREATE TABLE IF NOT EXISTS `routing_governance_states`');
    expect(
      mysqlUpgrade.includes('CREATE TABLE IF NOT EXISTS `routing_governance_states`')
      || mysqlUpgrade.includes('ALTER TABLE `proxy_logs` ADD COLUMN `cache_status`')
      || mysqlUpgrade.includes('ALTER TABLE `token_routes` ADD COLUMN `probe_policy`')
      || mysqlUpgrade.includes('-- no schema changes detected for mysql'),
    ).toBe(true);
    expect(postgresBootstrap).toContain('CREATE TABLE IF NOT EXISTS "response_cache"');
    expect(postgresBootstrap).toContain('"estimated_cost" DOUBLE PRECISION DEFAULT 0');
    expect(postgresBootstrap).toContain('CREATE UNIQUE INDEX "response_cache_key_idx"');
    expect(postgresBootstrap).toContain('CREATE TABLE IF NOT EXISTS "routing_governance_states"');
    expect(
      postgresUpgrade.includes('CREATE TABLE IF NOT EXISTS "routing_governance_states"')
      || postgresUpgrade.includes('ALTER TABLE "proxy_logs" ADD COLUMN "cache_status"')
      || postgresUpgrade.includes('ALTER TABLE "token_routes" ADD COLUMN "probe_policy"')
      || postgresUpgrade.includes('-- no schema changes detected for postgres'),
    ).toBe(true);
  });
});
