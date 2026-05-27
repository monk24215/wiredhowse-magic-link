import { sql } from 'drizzle-orm';
import type { Database } from '@wiredhowse/db';
import type { CronLogger, JobResult } from './types';

const JOB_NAME = 'cleanupMagicLinks';

/**
 * Hourly. Deletes magic_links created more than 24 hours ago.
 * These are either expired (15 min TTL) or redeemed — both are safe to purge.
 * The 24-hour window gives overlap for debugging before purge.
 */
export async function cleanupMagicLinks(db: Database, logger: CronLogger): Promise<JobResult> {
  const start = Date.now();
  try {
    const rows = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM magic_links
        WHERE created_at < now() - interval '24 hours'
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
