/**
 * Ad-hoc single-job runner for ops and local testing.
 *
 * Usage (from repo root):
 *   pnpm --filter @wiredhowse/api run-once <jobName>
 *
 * Available job names:
 *   cleanupMagicLinks
 *   cleanupHandoffTokens
 *   cleanupOauthState
 *   cleanupEmailVerifications
 *   cleanupPasswordResets
 *   cleanupExpiredSessions
 *   purgeArchivedEndUsers
 *   cleanupAuditLog
 *
 * Example:
 *   pnpm --filter @wiredhowse/api run-once cleanupAuditLog
 *
 * Exit code 0 = job ran (even if 0 rows deleted).
 * Exit code 1 = unknown job name or missing DATABASE_URL.
 */

import { db } from '@wiredhowse/db';
import { cronConfig } from './cron/config';
import {
  cleanupAuditLog,
  cleanupEmailVerifications,
  cleanupExpiredSessions,
  cleanupHandoffTokens,
  cleanupMagicLinks,
  cleanupOauthState,
  cleanupPasswordResets,
  purgeArchivedEndUsers,
} from './cron/jobs/index';
import type { CronLogger } from './cron/jobs/types';

// Minimal stderr logger — no Fastify/pino dependency needed for a one-shot script.
const logger: CronLogger = {
  info(obj, msg) {
    process.stdout.write(JSON.stringify({ level: 'info', ...obj, msg }) + '\n');
  },
  error(obj, msg) {
    process.stderr.write(JSON.stringify({ level: 'error', ...obj, msg }) + '\n');
  },
  warn(obj, msg) {
    process.stderr.write(JSON.stringify({ level: 'warn', ...obj, msg }) + '\n');
  },
};

const JOB_MAP: Record<string, () => Promise<{ deleted: number; durationMs: number }>> = {
  cleanupMagicLinks: () => cleanupMagicLinks(db, logger),
  cleanupHandoffTokens: () => cleanupHandoffTokens(db, logger),
  cleanupOauthState: () => cleanupOauthState(db, logger),
  cleanupEmailVerifications: () => cleanupEmailVerifications(db, logger),
  cleanupPasswordResets: () => cleanupPasswordResets(db, logger),
  cleanupExpiredSessions: () => cleanupExpiredSessions(db, logger),
  purgeArchivedEndUsers: () => purgeArchivedEndUsers(db, logger),
  cleanupAuditLog: () =>
    cleanupAuditLog(db, logger, cronConfig.AUDIT_LOG_RETENTION_DAYS),
};

async function main(): Promise<void> {
  const jobName = process.argv[2];

  if (!jobName) {
    process.stderr.write(
      `Usage: pnpm --filter @wiredhowse/api run-once <jobName>\n` +
        `Available jobs:\n` +
        Object.keys(JOB_MAP)
          .map((n) => `  ${n}`)
          .join('\n') +
        '\n',
    );
    process.exit(1);
  }

  const run = JOB_MAP[jobName];
  if (!run) {
    process.stderr.write(
      `Unknown job: "${jobName}"\nAvailable: ${Object.keys(JOB_MAP).join(', ')}\n`,
    );
    process.exit(1);
  }

  logger.info({ jobName }, 'running job once');
  const result = await run();
  logger.info({ jobName, ...result }, 'done');
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
