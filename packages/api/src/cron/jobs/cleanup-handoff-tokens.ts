import { sql } from 'drizzle-orm';
import type { Database } from '@wiredhowse/db';
import type { CronLogger, JobResult } from './types';

const JOB_NAME = 'cleanupHandoffTokens';

/**
 * Hourly. Deletes handoff_tokens created more than 1 hour ago.
 * Handoff tokens have a 60-second lifetime; after 1 hour they are well past
 * expiry and the raw_session_token they carry is safe to remove.
 */
export async function cleanupHandoffTokens(
  db: Database,
  logger: CronLogger,
): Promise<JobResult> {
  const start = Date.now();
  try {
    const rows = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM handoff_tokens
        WHERE created_at < now() - interval '1 hour'
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
