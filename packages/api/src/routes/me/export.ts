import { db, loginHistory, sessions, sites } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sendError } from '../../errors';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/me/export
   *
   * GDPR-style data export. Returns the End User's full profile, all sessions
   * (including expired and revoked — full history), and login history as a
   * single JSON response with Content-Disposition: attachment.
   *
   * Security note: token hashes, IP hashes, and user-agent hashes are
   * intentionally excluded — these are internal security fields, not user data.
   */
  app.get('/export', async (request, reply) => {
    const user = request.endUser;
    if (!user) {
      sendError(reply, 401, ErrorCode.UNAUTHENTICATED, 'Not authenticated');
      return;
    }

    // All sessions (any state) for full historical export
    const sessionRows = await db
      .select({
        id: sessions.id,
        siteId: sessions.siteId,
        siteDomain: sites.domain,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        lastUsedAt: sessions.lastUsedAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .innerJoin(sites, eq(sessions.siteId, sites.id))
      .where(eq(sessions.endUserId, user.id));

    // Full login history
    const historyRows = await db
      .select({
        id: loginHistory.id,
        siteId: loginHistory.siteId,
        siteDomain: sites.domain,
        occurredAt: loginHistory.occurredAt,
      })
      .from(loginHistory)
      .innerJoin(sites, eq(loginHistory.siteId, sites.id))
      .where(eq(loginHistory.endUserId, user.id));

    const exportData = {
      exported_at: new Date().toISOString(),
      profile: {
        id: user.id,
        email: user.email,
        email_verified_at: user.emailVerifiedAt,
        display_name: user.displayName,
        created_at: user.createdAt,
        last_seen_at: user.lastSeenAt,
      },
      sessions: sessionRows.map((row) => ({
        id: row.id,
        site_id: row.siteId,
        site_domain: row.siteDomain,
        created_at: row.createdAt,
        expires_at: row.expiresAt,
        last_used_at: row.lastUsedAt,
        revoked_at: row.revokedAt,
      })),
      login_history: historyRows.map((row) => ({
        id: row.id,
        site_id: row.siteId,
        site_domain: row.siteDomain,
        occurred_at: row.occurredAt,
      })),
    };

    const filename = `wiredhowse-data-export-${Date.now()}.json`;
    void reply.header('Content-Type', 'application/json');
    void reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.code(200).send(exportData);
  });
}
