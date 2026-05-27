import { sql } from 'drizzle-orm';
import type { Database } from '@wiredhowse/db';
import type { CronLogger, JobResult } from './types';

const JOB_NAME = 'cleanupAuditLog';

/**
 * Daily at 03:00 UTC. Deletes audit_log rows older than retentionDays.
 *
 * Default: 90 days (configurable via AUDIT_LOG_RETENTION_DAYS env var).
 * The interval is parameterized via `make_interval` so the value is passed
 * as a prepared-statement parameter, never interpolated as raw SQL text.
 *
 * Idempotent: re-running only deletes rows that are still past the cutoff.
 */
export async function cleanupAuditLog(
  db: Database,
  logger: CronLogger,
  retentionDays: number,
): Promise<JobResult> {
  const start = Date.now();
  try {
    const rows = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM audit_log
        WHERE occurred_at < now() - make_interval(days => ${retentionDays})
        RETURNING 1
      )
      SELECT count(*) AS count FROM deleted
    `);
    const deleted = Number(rows[0]?.count ?? 0);
    const durationMs = Date.now() - start;
    logger.info({ job: JOB_NAME, deleted, durationMs, retentionDays }, 'job complete');
    return { job: JOB_NAME, deleted, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.error({ job: JOB_NAME, durationMs, retentionDays, err }, 'job failed');
    return { job: JOB_NAME, deleted: 0, durationMs };
  }
}
