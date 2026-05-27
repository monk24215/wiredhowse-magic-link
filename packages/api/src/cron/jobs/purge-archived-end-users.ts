import { sql } from 'drizzle-orm';
import type { Database } from '@wiredhowse/db';
import type { CronLogger, JobResult } from './types';

const JOB_NAME = 'purgeArchivedEndUsers';

/**
 * Daily at 02:00 UTC. Permanently deletes archived_end_users rows where
 * purge_after < now().
 *
 * These rows were created by the "close and archive" flow. purge_after is set
 * to archived_at + 24 months (per GDPR retention policy). After that deadline,
 * even the hashed email and session summary are removed.
 *
 * Idempotent: re-running after a missed run deletes only what's past purge_after.
 */
export async function purgeArchivedEndUsers(
  db: Database,
  logger: CronLogger,
): Promise<JobResult> {
  const start = Date.now();
  try {
    const rows = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM archived_end_users
        WHERE purge_after < now()
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
