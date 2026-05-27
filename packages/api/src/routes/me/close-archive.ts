import { archivedEndUsers, db, endUsers, loginHistory, sessions, sites } from '@wiredhowse/db';
import { ErrorCode, closeAndArchiveSchema } from '@wiredhowse/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { send500, sendError } from '../../errors';
import { hashBytes } from '../../lib/hashing';
import { addMonths, nowUtc } from '../../lib/time';

export async function closeArchiveRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/me/close-and-archive
   *
   * Permanently deletes the End User's live records and writes an aggregate
   * archive row. The typed confirmation string `"DELETE MY DATA"` is required.
   *
   * Atomicity guarantee: everything runs inside a single Postgres transaction.
   * If any step fails the entire operation rolls back — nothing is deleted.
   *
   * What happens inside the transaction:
   *   1. Aggregate session + login stats per site into a session_summary JSONB
   *      (no PII — site IDs, domains, counts, first/last timestamps only).
   *   2. sha256(lowercase(email)) is computed for the email_hash column.
   *   3. INSERT INTO archived_end_users.
   *   4. DELETE FROM end_users WHERE id = <user>.
   *      - Cascades to: sessions, login_history (ON DELETE CASCADE).
   *
   * Returning user with the same email creates a brand-new end_users row.
   * The archive row has no FK back to end_users — the link is only forensic
   * (original_user_id text + email_hash). The returning user sees no history.
   */
  app.post('/close-and-archive', async (request, reply) => {
    const user = request.endUser;
    if (!user) {
      sendError(reply, 401, ErrorCode.UNAUTHENTICATED, 'Not authenticated');
      return;
    }

    const parsed = closeAndArchiveSchema.safeParse(request.body);
    if (!parsed.success) {
      sendError(
        reply,
        400,
        ErrorCode.INVALID_CONFIRMATION,
        'Invalid confirmation. Send { "confirmation": "DELETE MY DATA" }',
      );
      return;
    }

    const now = nowUtc();

    try {
      await db.transaction(async (tx) => {
        // Step 1: aggregate session stats per site (from sessions table)
        const sessionStats = await tx
          .select({
            siteId: sessions.siteId,
            siteDomain: sites.domain,
            totalSessions: sql<number>`count(*)::int`,
            firstSeen: sql<Date>`min(${sessions.createdAt})`,
            lastSeen: sql<Date>`max(${sessions.lastUsedAt})`,
          })
          .from(sessions)
          .innerJoin(sites, eq(sessions.siteId, sites.id))
          .where(eq(sessions.endUserId, user.id))
          .groupBy(sessions.siteId, sites.domain);

        // Step 2: aggregate login counts per site (from login_history table)
        const historyStats = await tx
          .select({
            siteId: loginHistory.siteId,
            totalLogins: sql<number>`count(*)::int`,
          })
          .from(loginHistory)
          .where(eq(loginHistory.endUserId, user.id))
          .groupBy(loginHistory.siteId);

        const historyMap = new Map<string, number>(
          historyStats.map((h) => [h.siteId, h.totalLogins]),
        );

        // Merge session stats + login counts into a single summary array
        const sessionSummaryMap = new Map<
          string,
          {
            site_id: string;
            domain: string;
            total_sessions: number;
            total_logins: number;
            first_seen: string | null;
            last_seen: string | null;
          }
        >();

        for (const s of sessionStats) {
          sessionSummaryMap.set(s.siteId, {
            site_id: s.siteId,
            domain: s.siteDomain,
            total_sessions: s.totalSessions,
            total_logins: historyMap.get(s.siteId) ?? s.totalSessions,
            first_seen: s.firstSeen ? new Date(s.firstSeen).toISOString() : null,
            last_seen: s.lastSeen ? new Date(s.lastSeen).toISOString() : null,
          });
        }

        // Include sites with login history but no current sessions
        for (const h of historyStats) {
          if (!sessionSummaryMap.has(h.siteId)) {
            const [siteRow] = await tx
              .select({ domain: sites.domain })
              .from(sites)
              .where(eq(sites.id, h.siteId))
              .limit(1);
            if (siteRow) {
              sessionSummaryMap.set(h.siteId, {
                site_id: h.siteId,
                domain: siteRow.domain,
                total_sessions: 0,
                total_logins: h.totalLogins,
                first_seen: null,
                last_seen: null,
              });
            }
          }
        }

        const sessionSummary = [...sessionSummaryMap.values()];

        // Step 3: compute email_hash — sha256(lowercase(email)), stored as bytea
        // The plaintext email is NOT copied to the archive table.
        const emailHash = hashBytes(user.email.toLowerCase());

        // Step 4: insert the archive row
        await tx.insert(archivedEndUsers).values({
          emailHash,
          originalUserId: user.id,
          archivedAt: now,
          purgeAfter: addMonths(now, 24),
          sessionSummary,
        });

        // Step 5: delete the end_users row.
        // FK cascades: sessions (ON DELETE CASCADE) + login_history (ON DELETE CASCADE)
        // are wiped automatically. No PII survives in the live tables.
        await tx.delete(endUsers).where(eq(endUsers.id, user.id));
      });
    } catch (err) {
      request.log.error({ err }, 'close-and-archive: transaction failed — no data was deleted');
      send500(reply, 'Failed to archive data. No changes were made.');
      return;
    }

    return reply.code(204).send();
  });
}
