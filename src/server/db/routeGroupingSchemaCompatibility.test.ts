import { describe, expect, it } from 'vitest';
import {
  ensureRouteGroupingSchemaCompatibility,
  type RouteGroupingSchemaInspector,
} from './routeGroupingSchemaCompatibility.js';

function createInspector(
  dialect: RouteGroupingSchemaInspector['dialect'],
  options?: {
    existingColumnsByTable?: Partial<Record<'token_routes' | 'route_channels', string[]>>;
  },
) {
  const executedSql: string[] = [];
  const existingColumnsByTable = {
    token_routes: new Set(options?.existingColumnsByTable?.token_routes ?? []),
    route_channels: new Set(options?.existingColumnsByTable?.route_channels ?? []),
  };

  const inspector: RouteGroupingSchemaInspector = {
    dialect,
    async tableExists(table) {
      return table === 'token_routes' || table === 'route_channels';
    },
    async columnExists(table, column) {
      if (table === 'token_routes' || table === 'route_channels') {
        return existingColumnsByTable[table].has(column);
      }
      return false;
    },
    async execute(sqlText) {
      executedSql.push(sqlText);
    },
  };

  return { inspector, executedSql };
}

describe('ensureRouteGroupingSchemaCompatibility', () => {
  it.each([
    {
      dialect: 'sqlite' as const,
      expectedSql: [
        'ALTER TABLE token_routes ADD COLUMN display_name text;',
        'ALTER TABLE token_routes ADD COLUMN display_icon text;',
        'ALTER TABLE token_routes ADD COLUMN decision_snapshot text;',
        'ALTER TABLE token_routes ADD COLUMN decision_refreshed_at text;',
        'ALTER TABLE token_routes ADD COLUMN routing_strategy text DEFAULT \'weighted\';',
        'ALTER TABLE route_channels ADD COLUMN source_model text;',
        'ALTER TABLE route_channels ADD COLUMN last_selected_at text;',
        'ALTER TABLE route_channels ADD COLUMN consecutive_fail_count integer NOT NULL DEFAULT 0;',
        'ALTER TABLE route_channels ADD COLUMN cooldown_level integer NOT NULL DEFAULT 0;',
      ],
    },
    {
      dialect: 'postgres' as const,
      expectedSql: [
        'ALTER TABLE "token_routes" ADD COLUMN "display_name" TEXT',
        'ALTER TABLE "token_routes" ADD COLUMN "display_icon" TEXT',
        'ALTER TABLE "token_routes" ADD COLUMN "decision_snapshot" TEXT',
        'ALTER TABLE "token_routes" ADD COLUMN "decision_refreshed_at" TEXT',
        'ALTER TABLE "token_routes" ADD COLUMN "routing_strategy" TEXT DEFAULT \'weighted\'',
        'ALTER TABLE "route_channels" ADD COLUMN "source_model" TEXT',
        'ALTER TABLE "route_channels" ADD COLUMN "last_selected_at" TEXT',
        'ALTER TABLE "route_channels" ADD COLUMN "consecutive_fail_count" INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE "route_channels" ADD COLUMN "cooldown_level" INTEGER NOT NULL DEFAULT 0',
      ],
    },
    {
      dialect: 'mysql' as const,
      expectedSql: [
        'ALTER TABLE `token_routes` ADD COLUMN `display_name` TEXT NULL',
        'ALTER TABLE `token_routes` ADD COLUMN `display_icon` TEXT NULL',
        'ALTER TABLE `token_routes` ADD COLUMN `decision_snapshot` TEXT NULL',
        'ALTER TABLE `token_routes` ADD COLUMN `decision_refreshed_at` TEXT NULL',
        'ALTER TABLE `token_routes` ADD COLUMN `routing_strategy` VARCHAR(32) NULL DEFAULT \'weighted\'',
        'ALTER TABLE `route_channels` ADD COLUMN `source_model` TEXT NULL',
        'ALTER TABLE `route_channels` ADD COLUMN `last_selected_at` TEXT NULL',
        'ALTER TABLE `route_channels` ADD COLUMN `consecutive_fail_count` INT NOT NULL DEFAULT 0',
        'ALTER TABLE `route_channels` ADD COLUMN `cooldown_level` INT NOT NULL DEFAULT 0',
      ],
    },
  ])('adds missing route grouping columns for $dialect', async ({ dialect, expectedSql }) => {
    const { inspector, executedSql } = createInspector(dialect);

    await ensureRouteGroupingSchemaCompatibility(inspector);

    expect(executedSql).toEqual(expectedSql);
  });

  it('skips existing columns', async () => {
    const { inspector, executedSql } = createInspector('postgres', {
      existingColumnsByTable: {
        token_routes: ['display_name', 'display_icon', 'decision_snapshot', 'decision_refreshed_at', 'routing_strategy'],
        route_channels: ['source_model', 'last_selected_at', 'consecutive_fail_count', 'cooldown_level'],
      },
    });

    await ensureRouteGroupingSchemaCompatibility(inspector);

    expect(executedSql).toEqual([]);
  });
});
