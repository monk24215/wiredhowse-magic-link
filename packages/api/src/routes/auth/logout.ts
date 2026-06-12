import { db, siteOwnerSessions } from '@wiredhowse/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { clearCsrfCookie, clearOwnerSessionCookie } from '../../lib/cookies';
import { nowUtc } from '../../lib/time';
import { requireCsrfToken } from '../../middleware/csrf';
import { requireSiteOwnerSession } from '../../middleware/auth-owner';

export async function logoutRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/logout
   *
   * Revokes the current dashboard session and clears the browser cookies.
   * Idempotent — safe to call even if the session has already expired.
   *
   * Requires:
   *   - A valid wh_owner_session cookie (401 if absent/expired)
   *   - X-CSRF-Token header matching the wh_csrf cookie (403 if missing/invalid)
   */
  app.post(
    '/logout',
    { preHandler: [requireSiteOwnerSession, requireCsrfToken] },
    async (request, reply) => {
      const sessionId = request.ownerSessionId;
      if (sessionId) {
        await db
          .update(siteOwnerSessions)
          .set({ revokedAt: nowUtc() })
          .where(eq(siteOwnerSessions.id, sessionId));
      }

      void reply.header('Set-Cookie', clearOwnerSessionCookie());
      void reply.header('Set-Cookie', clearCsrfCookie());

      return reply.code(200).send({ data: { signed_out: true } });
    },
  );
}
