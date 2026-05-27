import cron from 'node-cron';
import type { Database } from '@wiredhowse/db';
import { db } from '@wiredhowse/db';
import { cronConfig } from './config';
import type { CronLogger } from './jobs/types';
import {
  cleanupAuditLog,
  cleanupEmailVerifications,
  cleanupExpiredSessions,
  cleanupHandoffTokens,
  cleanupMagicLinks,
  cleanupOauthState,
  cleanupPasswordResets,
  purgeArchivedEndUsers,
} from './jobs/index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SimpleFn = (db: Database, logger: CronLogger) => Promise<{ job: string; deleted: number; durationMs: number }>;

export interface SchedulerHandle {
  /** Activate all cron tasks. Call once at startup. */
  start(): void;
  /** Stop all cron tasks. Call on graceful shutdown. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs a list of job functions sequentially against the shared DB.
 * One failing job emits an error log (the job handles it internally) but
 * does NOT prevent subsequent jobs from running — each job has its own catch.
 */
async function runGroup(
  jobs: SimpleFn[],
  database: Database,
  logger: CronLogger,
): Promise<void> {
  for (const job of jobs) {
    await job(database, logger);
  }
}

// ---------------------------------------------------------------------------
// Scheduler factory
// ---------------------------------------------------------------------------

/**
 * Creates a scheduler handle. Inject a logger (from Fastify or elsewhere).
 * Call `.start()` to activate all cron tasks.
 */
export function createScheduler(logger: CronLogger): SchedulerHandle {
  const { AUDIT_LOG_RETENTION_DAYS } = cronConfig;

  // Wrap cleanupAuditLog to match the SimpleFn signature (no extra args).
  const auditLogJob: SimpleFn = (database, log) =>
    cleanupAuditLog(database, log, AUDIT_LOG_RETENTION_DAYS);

  const hourlyJobs: SimpleFn[] = [
    cleanupMagicLinks,
    cleanupHandoffTokens,
    cleanupOauthState,
    cleanupEmailVerifications,
    cleanupPasswordResets,
  ];

  const daily02Jobs: SimpleFn[] = [cleanupExpiredSessions, purgeArchivedEndUsers];

  const daily03Jobs: SimpleFn[] = [auditLogJob];

  const tasks: cron.ScheduledTask[] = [];

  return {
    start() {
      // Every hour at :00 (UTC)
      tasks.push(
        cron.schedule(
          '0 * * * *',
          () => {
            void runGroup(hourlyJobs, db, logger);
          },
          { timezone: 'UTC' },
        ),
      );

      // Daily at 02:00 UTC — expired sessions + GDPR archive purge
      tasks.push(
        cron.schedule(
          '0 2 * * *',
          () => {
            void runGroup(daily02Jobs, db, logger);
          },
          { timezone: 'UTC' },
        ),
      );

      // Daily at 03:00 UTC — audit log retention
      tasks.push(
        cron.schedule(
          '0 3 * * *',
          () => {
            void runGroup(daily03Jobs, db, logger);
          },
          { timezone: 'UTC' },
        ),
      );

      logger.info(
        {
          hourlyJobs: hourlyJobs.map((f) => f.name),
          daily02Jobs: daily02Jobs.map((f) => f.name),
          daily03Jobs: daily03Jobs.map((f) => f.name),
          auditLogRetentionDays: AUDIT_LOG_RETENTION_DAYS,
        },
        'cron scheduler started',
      );
    },

    stop() {
      for (const task of tasks) {
        task.stop();
      }
      logger.info({}, 'cron scheduler stopped');
    },
  };
}
