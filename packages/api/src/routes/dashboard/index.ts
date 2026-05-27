import type { FastifyInstance } from 'fastify';
import { accountRoutes } from './account';
import { siteMetricsRoutes } from './site-metrics';
import { siteVerifyRoutes } from './site-verify';
import { siteRoutes } from './sites';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  void app.register(siteRoutes, { prefix: '/sites' });
  void app.register(siteVerifyRoutes, { prefix: '/sites' });
  void app.register(siteMetricsRoutes, { prefix: '/sites' });
  void app.register(accountRoutes);
}
