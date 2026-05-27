import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CSRF_COOKIE, buildCsrfCookie } from '../../lib/cookies';
import { requireEndUserSession } from '../../middleware/auth-session';
import { requireCsrfToken } from '../../middleware/csrf';
import { readCookieValue } from '../../middleware/csrf';
import { closeArchiveRoutes } from './close-archive';
import { exportRoutes } from './export';
import { profileRoutes } from './profile';
import { sessionsRoutes } from './sessions';

/**
 * End User self-service routes — /v1/me/*
 *
 * Authentication: Bearer wh_s_<token> (from localStorage on the customer site,
 * or from the URL hash when the End User navigates to magic-link.wiredhowse.app/me).
 *
 * CSRF protection: on state-changing requests (POST/PATCH/DELETE), the client
 * must include an X-CSRF-Token header matching the wh_csrf cookie.
 * The cookie is issued on the first successful GET request to this namespace
 * so the /me page can read it and attach it to subsequent mutations.
 *
 * These routes are NOT cookie-gated for authentication. The bearer token comes
 * from the snippet/localStorage context. Keep this scheme isolated from the
 * Site Owner dashboard which uses `wh_owner_session` cookies.
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  // 1. Auth guard: all routes require a valid End User session.
  app.addHook('preHandler', requireEndUserSession);

  // 2. CSRF: validate X-CSRF-Token == wh_csrf cookie on mutations.
  //    Safe methods (GET, HEAD, OPTIONS) are skipped inside the middleware.
  app.addHook('preHandler', requireCsrfToken);

  // 3. Issue a wh_csrf cookie on successful GET responses so the /me page
  //    can read it and attach it to subsequent PATCH/POST requests.
  //    Only issued when the session is valid (endUser is set) and the
  //    cookie is not already present (avoids invalidating in-flight requests).
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'GET' && request.endUser) {
      const existing = readCookieValue(request.headers.cookie, CSRF_COOKIE);
      if (!existing) {
        const rawCsrfToken = randomBytes(32).toString('base64url');
        void reply.header('Set-Cookie', buildCsrfCookie(rawCsrfToken));
      }
    }
    return payload;
  });

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
