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
      dialect: 'postgres' as const,
      expectedSql: [
        'ALTER TABLE "token_routes" ADD COLUMN "display_name" TEXT',
        'ALTER TABLE "token_routes" ADD COLUMN "display_icon" TEXT',
        'ALTER TABLE "token_routes" ADD COLUMN "decision_snapshot" TEXT',
        'ALTER TABLE "token_routes" ADD COLUMN "decision_refreshed_at" TEXT',
        'ALTER TABLE "route_channels" ADD COLUMN "source_model" TEXT',
      ],
    },
    {
      dialect: 'mysql' as const,
      expectedSql: [
        'ALTER TABLE `token_routes` ADD COLUMN `display_name` TEXT NULL',
        'ALTER TABLE `token_routes` ADD COLUMN `display_icon` TEXT NULL',
        'ALTER TABLE `token_routes` ADD COLUMN `decision_snapshot` TEXT NULL',
        'ALTER TABLE `token_routes` ADD COLUMN `decision_refreshed_at` TEXT NULL',
        'ALTER TABLE `route_channels` ADD COLUMN `source_model` TEXT NULL',
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
        token_routes: ['display_name', 'display_icon', 'decision_snapshot', 'decision_refreshed_at'],
        route_channels: ['source_model'],
      },
    });

    await ensureRouteGroupingSchemaCompatibility(inspector);

    expect(executedSql).toEqual([]);
  });
});
