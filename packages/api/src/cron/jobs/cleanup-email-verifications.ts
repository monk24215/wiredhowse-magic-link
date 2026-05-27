import { sql } from 'drizzle-orm';
import type { Database } from '@wiredhowse/db';
import type { CronLogger, JobResult } from './types';

const JOB_NAME = 'cleanupEmailVerifications';

/**
 * Hourly. Deletes email_verifications whose expires_at is more than 7 days in the past.
 * Tokens expire after 24 hours; the extra 7-day grace period allows debugging.
 */
export async function cleanupEmailVerifications(
  db: Database,
  logger: CronLogger,
): Promise<JobResult> {
  const start = Date.now();
  try {
    const rows = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM email_verifications
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
