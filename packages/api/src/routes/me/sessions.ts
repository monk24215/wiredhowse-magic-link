import { db, sessions, sites } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { send404, sendError } from '../../errors';
import { nowUtc } from '../../lib/time';

export async function sessionsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/me/sessions
   *
   * Lists all active (non-revoked, non-expired) sessions for this End User
   * across all Sites. Includes the `is_current` flag so the UI can highlight
   * the caller's own session without exposing the raw token.
   */
  app.get('/sessions', async (request, reply) => {
    const user = request.endUser;
    if (!user) {
      sendError(reply, 401, ErrorCode.UNAUTHENTICATED, 'Not authenticated');
      return;
    }

    const now = nowUtc();

    const rows = await db
      .select({
        id: sessions.id,
        siteId: sessions.siteId,
        siteDomain: sites.domain,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        lastUsedAt: sessions.lastUsedAt,
      })
      .from(sessions)
      .innerJoin(sites, eq(sessions.siteId, sites.id))
      .where(
        and(
          eq(sessions.endUserId, user.id),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      )
      .orderBy(desc(sessions.lastUsedAt));

    return reply.code(200).send({
      data: {
        sessions: rows.map((row) => ({
          id: row.id,
          site_id: row.siteId,
          site_domain: row.siteDomain,
          created_at: row.createdAt,
          expires_at: row.expiresAt,
          last_used_at: row.lastUsedAt,
          is_current: row.id === request.sessionId,
        })),
      },
    });
  });

  /**
   * POST /v1/me/sessions/revoke-all
   *
   * Revokes every session for this End User, including the calling one.
   * Callers should clear local storage immediately after receiving 204.
   *
   * IMPORTANT: this route must be registered BEFORE /:id/revoke so Fastify's
   * router matches the literal "revoke-all" before the ":id" wildcard — even
   * though the paths differ in length (`/sessions/revoke-all` vs
   * `/sessions/:id/revoke`), registering statics first is good practice.
   */
  app.post('/sessions/revoke-all', async (request, reply) => {
    const user = request.endUser;
    if (!user) {
      sendError(reply, 401, ErrorCode.UNAUTHENTICATED, 'Not authenticated');
      return;
    }

    const now = nowUtc();

    await db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.endUserId, user.id), isNull(sessions.revokedAt)));

    return reply.code(204).send();
  });

  /**
   * POST /v1/me/sessions/:id/revoke
   *
   * Revokes one specific session. The WHERE clause enforces that the session
   * belongs to the calling End User, preventing cross-user revocation even
   * with a guessed session ID.
   *
   * Returns 404 if the session is not found, already revoked, or belongs to
   * a different End User.
   */
  app.post('/sessions/:id/revoke', async (request, reply) => {
    const user = request.endUser;
    if (!user) {
      sendError(reply, 401, ErrorCode.UNAUTHENTICATED, 'Not authenticated');
      return;
    }

    const { id } = request.params as { id: string };
    const now = nowUtc();

    const [revoked] = await db
      .update(sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.endUserId, user.id), // cross-user isolation guard
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });

    if (!revoked) {
      send404(reply, 'Session not found');
      return;
    }

    return reply.code(204).send();
  });
}
