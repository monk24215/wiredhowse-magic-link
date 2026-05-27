import { db, loginHistory, sessions, sites } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { and, count, eq, gt, isNull, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { send404, sendError } from '../../errors';
import { addHours, nowUtc } from '../../lib/time';
export async function siteMetricsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/dashboard/sites/:id/clear-sessions
   *
   * Revoke all active sessions for the site. Returns the count revoked.
   */
  app.post('/:id/clear-sessions', async (request, reply) => {
    const owner = request.siteOwner;
    if (!owner) return;

    const { id } = request.params as { id: string };

    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, id), eq(sites.siteOwnerId, owner.id)))
      .limit(1);

    if (!site) {
      send404(reply, 'Site not found');
      return;
    }

    const now = nowUtc();

    const revoked = await db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.siteId, site.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return reply.code(200).send({
      data: { sessions_revoked: revoked.length },
    });
  });

  /**
   * GET /v1/dashboard/sites/:id/metrics
   *
   * Return activity metrics for the site.
   */
  app.get('/:id/metrics', async (request, reply) => {
    const owner = request.siteOwner;
    if (!owner) return;

    const { id } = request.params as { id: string };

    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, id), eq(sites.siteOwnerId, owner.id)))
      .limit(1);

    if (!site) {
      send404(reply, 'Site not found');
      return;
    }

    const now = nowUtc();
    const minus24h = addHours(now, -24);
    const minus7d = addHours(now, -24 * 7);
    const minus30d = addHours(now, -24 * 30);

    const [activeRow, logins24hRow, logins7dRow, logins30dRow, lastActivityRow] = await Promise.all(
      [
        db
          .select({ count: count() })
          .from(sessions)
          .where(
            and(
              eq(sessions.siteId, site.id),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, now),
            ),
          )
          .then((rows) => rows[0]),

        db
          .select({ count: count() })
          .from(loginHistory)
          .where(and(eq(loginHistory.siteId, site.id), gt(loginHistory.occurredAt, minus24h)))
          .then((rows) => rows[0]),

        db
          .select({ count: count() })
          .from(loginHistory)
          .where(and(eq(loginHistory.siteId, site.id), gt(loginHistory.occurredAt, minus7d)))
          .then((rows) => rows[0]),

        db
          .select({ count: count() })
          .from(loginHistory)
          .where(and(eq(loginHistory.siteId, site.id), gt(loginHistory.occurredAt, minus30d)))
          .then((rows) => rows[0]),

        db
          .select({ max: max(loginHistory.occurredAt) })
          .from(loginHistory)
          .where(eq(loginHistory.siteId, site.id))
          .then((rows) => rows[0]),
      ],
    );

    return reply.code(200).send({
      data: {
        active_sessions: activeRow?.count ?? 0,
        logins_24h: logins24hRow?.count ?? 0,
        logins_7d: logins7dRow?.count ?? 0,
        logins_30d: logins30dRow?.count ?? 0,
        last_activity_at: lastActivityRow?.max ?? null,
      },
    });
  });
}
