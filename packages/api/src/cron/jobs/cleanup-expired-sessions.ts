import { sql } from 'drizzle-orm';
import type { Database } from '@wiredhowse/db';
import type { CronLogger, JobResult } from './types';

const JOB_NAME = 'cleanupExpiredSessions';

/**
 * Daily at 02:00 UTC. Deletes sessions expired more than 7 days ago.
 *
 * Sessions can expire up to 12 hours after creation. The 7-day grace period
 * ensures no live session is deleted. login_history rows are unaffected
 * (their session_id FK is SET NULL on session delete — the login count for
 * tier calculation is preserved on the login_history row itself).
 */
export async function cleanupExpiredSessions(
  db: Database,
  logger: CronLogger,
): Promise<JobResult> {
  const start = Date.now();
  try {
    const rows = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM sessions
        WHERE expires_at < now() - interval '7 days'
        RETURNING 1
      )
      SELECT count(*) AS count FROM deleted
    `);
    const deleted = Number(rows[0]?.count ?? 0);
    const durationMs = Date.now() - start;
    logger.info({ job: JOB_NAME, deleted, durationMs }, 'job complete');
    return { job: JOB_NAME, deleted, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.error({ job: JOB_NAME, durationMs, err }, 'job failed');
    return { job: JOB_NAME, deleted: 0, durationMs };
  }
}
