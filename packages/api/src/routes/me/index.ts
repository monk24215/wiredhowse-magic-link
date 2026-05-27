import type { FastifyInstance } from 'fastify';
import { requireEndUserSession } from '../../middleware/auth-session';
import { closeArchiveRoutes } from './close-archive';
import { exportRoutes } from './export';
import { profileRoutes } from './profile';
import { sessionsRoutes } from './sessions';

/**
 * End User self-service routes — /v1/me/*
 *
 * All routes require a valid End User session token:
 *   Authorization: Bearer wh_s_<token>
 *
 * These are NOT cookie-gated. The token comes from localStorage/sessionStorage
 * set by the snippet on the customer site, or passed via URL hash to the /me
 * page. Keep this auth scheme isolated from the Site Owner dashboard which uses
 * `wh_owner_session` cookies.
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  // Auth guard applied to the whole /v1/me namespace
  app.addHook('preHandler', requireEndUserSession);

  // GET / → GET /v1/me (profile)
  // PATCH / → PATCH /v1/me
  void app.register(profileRoutes);

  // GET /sessions, POST /sessions/revoke-all, POST /sessions/:id/revoke
  void app.register(sessionsRoutes);

  // POST /close-and-archive
  void app.register(closeArchiveRoutes);

  // GET /export
  void app.register(exportRoutes);
}
