import type { FastifyInstance } from 'fastify';
import { requireSiteOwnerSession } from '../../middleware/auth-owner';
import { requireCsrfToken } from '../../middleware/csrf';
import { accountRoutes } from './account';
import { siteMetricsRoutes } from './site-metrics';
import { siteVerifyRoutes } from './site-verify';
import { siteRoutes } from './sites';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // 1. Auth guard first: all dashboard routes require a valid owner session.
  //    Running auth before CSRF ensures unauthenticated requests get 401, not 403.
  app.addHook('preHandler', requireSiteOwnerSession);

  // 2. CSRF double-submit token check applies to every state-changing request in
  //    this scope (POST, PUT, PATCH, DELETE). GET/HEAD/OPTIONS are skipped inside
  //    the middleware itself. Runs after auth so 401 takes priority over 403.
  app.addHook('preHandler', requireCsrfToken);

  void app.register(siteRoutes, { prefix: '/sites' });
  void app.register(siteVerifyRoutes, { prefix: '/sites' });
  void app.register(siteMetricsRoutes, { prefix: '/sites' });
  void app.register(accountRoutes);
}
