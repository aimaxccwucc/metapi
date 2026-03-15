import { describe, expect, it, vi } from 'vitest';
import { ensureRuntimeDatabaseReady } from './runtimeDatabaseBootstrap.js';

describe('runtimeDatabaseBootstrap', () => {
  it('runs sqlite runtime migrations when dialect is sqlite', async () => {
    const runSqliteRuntimeMigrations = vi.fn(async () => {});
    const ensureExternalRuntimeSchema = vi.fn(async () => {});

    await ensureRuntimeDatabaseReady({
      dialect: 'sqlite',
      runSqliteRuntimeMigrations,
      ensureExternalRuntimeSchema,
    });

    expect(runSqliteRuntimeMigrations).toHaveBeenCalledTimes(1);
    expect(ensureExternalRuntimeSchema).not.toHaveBeenCalled();
  });

  it.each(['postgres', 'mysql'] as const)('bootstraps external schema when dialect is %s and schema is missing', async (dialect) => {
    const runSqliteRuntimeMigrations = vi.fn(async () => {});
    const ensureExternalRuntimeSchema = vi.fn(async () => {});
    const externalRuntimeSchemaAlreadyInitialized = vi.fn(async () => false);

    await ensureRuntimeDatabaseReady({
      dialect,
      runSqliteRuntimeMigrations,
      ensureExternalRuntimeSchema,
      externalRuntimeSchemaAlreadyInitialized,
    });

    expect(externalRuntimeSchemaAlreadyInitialized).toHaveBeenCalledTimes(1);
    expect(ensureExternalRuntimeSchema).toHaveBeenCalledTimes(1);
    expect(runSqliteRuntimeMigrations).not.toHaveBeenCalled();
  });

  it.each(['postgres', 'mysql'] as const)('skips external bootstrap when schema already exists for %s', async (dialect) => {
    const runSqliteRuntimeMigrations = vi.fn(async () => {});
    const ensureExternalRuntimeSchema = vi.fn(async () => {});
    const externalRuntimeSchemaAlreadyInitialized = vi.fn(async () => true);

    await ensureRuntimeDatabaseReady({
      dialect,
      runSqliteRuntimeMigrations,
      ensureExternalRuntimeSchema,
      externalRuntimeSchemaAlreadyInitialized,
    });

    expect(externalRuntimeSchemaAlreadyInitialized).toHaveBeenCalledTimes(1);
    expect(ensureExternalRuntimeSchema).not.toHaveBeenCalled();
    expect(runSqliteRuntimeMigrations).not.toHaveBeenCalled();
  });
});
