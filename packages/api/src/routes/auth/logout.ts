import { db, siteOwnerSessions } from '@wiredhowse/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { clearOwnerSessionCookie } from '../../lib/cookies';
import { nowUtc } from '../../lib/time';
import { requireSiteOwnerSession } from '../../middleware/auth-owner';

export async function logoutRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/logout
   *
   * Revokes the current dashboard session and clears the browser cookie.
   * Idempotent — safe to call even if the session has already expired.
   * Requires a valid dashboard session (401 if absent/expired).
   */
  app.post('/logout', { preHandler: requireSiteOwnerSession }, async (request, reply) => {
    const sessionId = request.ownerSessionId;
    if (sessionId) {
      await db
        .update(siteOwnerSessions)
        .set({ revokedAt: nowUtc() })
        .where(eq(siteOwnerSessions.id, sessionId));
    }

    void reply.header('Set-Cookie', clearOwnerSessionCookie());

    return reply.code(200).send({ data: { signed_out: true } });
  });
}
