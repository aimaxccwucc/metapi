import { buildConfig, config } from '../config.js';
import { db, schema, switchRuntimeDatabase } from '../db/index.js';
import { updateBalanceRefreshCron, updateCheckinCron } from './checkinScheduler.js';
import { ensureDefaultSitesSeeded } from './defaultSiteSeedService.js';
import { invalidateSiteProxyCache } from './siteProxy.js';

export const FACTORY_RESET_ADMIN_TOKEN = 'change-me-admin-token';

type FactoryResetDependencies = {
  switchRuntimeDatabase?: typeof switchRuntimeDatabase;
  runSqliteMigrations?: () => Promise<void> | void;
  ensureDefaultSitesSeeded?: typeof ensureDefaultSitesSeeded;
};

async function clearAllBusinessData() {
  await db.transaction(async (tx) => {
    await tx.delete(schema.routeChannels).run();
    await tx.delete(schema.tokenModelAvailability).run();
    await tx.delete(schema.modelAvailability).run();
    await tx.delete(schema.proxyLogs).run();
    await tx.delete(schema.proxyVideoTasks).run();
    await tx.delete(schema.checkinLogs).run();
    await tx.delete(schema.accountTokens).run();
    await tx.delete(schema.accounts).run();
    await tx.delete(schema.tokenRoutes).run();
    await tx.delete(schema.sites).run();
    await tx.delete(schema.downstreamApiKeys).run();
    await tx.delete(schema.events).run();
    await tx.delete(schema.settings).run();
  });
}

function resetRuntimeConfigToInitialState() {
  const baseline = buildConfig(process.env);
  Object.assign(config, baseline);
  config.authToken = FACTORY_RESET_ADMIN_TOKEN;
  config.dbType = 'sqlite';
  config.dbUrl = '';
  config.dbSsl = false;
  updateCheckinCron(config.checkinCron);
  updateBalanceRefreshCron(config.balanceRefreshCron);
  invalidateSiteProxyCache();
}

async function runDefaultSqliteMigrations() {
  const migrateModule = await import('../db/migrate.js');
  migrateModule.runSqliteMigrations();
}

export async function performFactoryReset(deps: FactoryResetDependencies = {}): Promise<void> {
  const switchRuntimeDatabaseImpl = deps.switchRuntimeDatabase ?? switchRuntimeDatabase;
  const runSqliteMigrationsImpl = deps.runSqliteMigrations ?? runDefaultSqliteMigrations;
  const ensureDefaultSitesSeededImpl = deps.ensureDefaultSitesSeeded ?? ensureDefaultSitesSeeded;

  await clearAllBusinessData();
  resetRuntimeConfigToInitialState();
  await switchRuntimeDatabaseImpl('sqlite', '', false);
  await runSqliteMigrationsImpl();
  await clearAllBusinessData();
  await ensureDefaultSitesSeededImpl();
}
