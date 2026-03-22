import { FastifyInstance } from 'fastify';
import { registerAccountMaintenanceRoutes } from './routes/accountMaintenance.js';
import { registerMarketplaceModelTestRoutes } from './routes/marketplaceModelTest.js';
import { registerSettingsCustomRoutes } from './routes/settingsCustom.js';
import { registerSiteOpsRoutes } from './routes/siteOps.js';

export async function registerCustomRoutes(app: FastifyInstance) {
  await app.register(registerAccountMaintenanceRoutes);
  await app.register(registerMarketplaceModelTestRoutes);
  await app.register(registerSiteOpsRoutes);
  await app.register(registerSettingsCustomRoutes);
}
