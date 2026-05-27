/**
 * Unit tests for individual cron job functions.
 *
 * These tests mock the DB entirely — no Docker, no real Postgres.
 * They verify: DB execute is called, returned counts are surfaced, and failures
 * are caught/logged without throwing.
 *
 * We pass mocks as `unknown as Database` (cast through unknown) — the same
 * escape hatch used throughout the test suite for Drizzle dependency injection.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@wiredhowse/db';
import type { CronLogger, JobResult } from '../../src/cron/jobs/types';

// ---------------------------------------------------------------------------
// Job imports — pure functions, no side-effecting module-level code
// ---------------------------------------------------------------------------
import { cleanupAuditLog } from '../../src/cron/jobs/cleanup-audit-log';
import { cleanupEmailVerifications } from '../../src/cron/jobs/cleanup-email-verifications';
import { cleanupExpiredSessions } from '../../src/cron/jobs/cleanup-expired-sessions';
import { cleanupHandoffTokens } from '../../src/cron/jobs/cleanup-handoff-tokens';
import { cleanupMagicLinks } from '../../src/cron/jobs/cleanup-magic-links';
import { cleanupOauthState } from '../../src/cron/jobs/cleanup-oauth-state';
import { cleanupPasswordResets } from '../../src/cron/jobs/cleanup-password-resets';
import { purgeArchivedEndUsers } from '../../src/cron/jobs/purge-archived-end-users';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockDb(count: string): Database {
  return {
    execute: vi.fn().mockResolvedValue([{ count }]),
  } as unknown as Database;
}

function makeFailingDb(err: Error): Database {
  return {
    execute: vi.fn().mockRejectedValue(err),
  } as unknown as Database;
}

function makeLogger(): { logger: CronLogger; infoCalls: unknown[]; errorCalls: unknown[] } {
  const infoCalls: unknown[] = [];
  const errorCalls: unknown[] = [];
  const logger: CronLogger = {
    info: vi.fn((obj, msg) => infoCalls.push({ ...obj, msg })),
    error: vi.fn((obj, msg) => errorCalls.push({ ...obj, msg })),
    warn: vi.fn(),
  };
  return { logger, infoCalls, errorCalls };
}

// ---------------------------------------------------------------------------
// cleanupMagicLinks
// ---------------------------------------------------------------------------
describe('cleanupMagicLinks', () => {
  it('returns deleted count from DB', async () => {
    const db = makeMockDb('7');
    const { logger } = makeLogger();
    const result = await cleanupMagicLinks(db, logger);
    expect(result.job).toBe('cleanupMagicLinks');
    expect(result.deleted).toBe(7);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 0 when nothing to delete', async () => {
    const db = makeMockDb('0');
    const { logger } = makeLogger();
    const result = await cleanupMagicLinks(db, logger);
    expect(result.deleted).toBe(0);
  });

  it('logs info on success', async () => {
    const db = makeMockDb('3');
    const { logger, infoCalls } = makeLogger();
    await cleanupMagicLinks(db, logger);
    expect(infoCalls).toHaveLength(1);
    expect((infoCalls[0] as { msg: string }).msg).toBe('job complete');
  });

  it('catches DB errors and returns deleted=0 without throwing', async () => {
    const db = makeFailingDb(new Error('connection refused'));
    const { logger, errorCalls } = makeLogger();
    const result = await cleanupMagicLinks(db, logger);
    expect(result.deleted).toBe(0);
    expect(errorCalls).toHaveLength(1);
    expect((errorCalls[0] as { msg: string }).msg).toBe('job failed');
  });
});

// ---------------------------------------------------------------------------
// cleanupHandoffTokens
// ---------------------------------------------------------------------------
describe('cleanupHandoffTokens', () => {
  it('returns deleted count', async () => {
    const db = makeMockDb('2');
    const { logger } = makeLogger();
    const result = await cleanupHandoffTokens(db, logger);
    expect(result.job).toBe('cleanupHandoffTokens');
    expect(result.deleted).toBe(2);
  });

  it('catches errors', async () => {
    const db = makeFailingDb(new Error('db error'));
    const { logger } = makeLogger();
    const result = await cleanupHandoffTokens(db, logger);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupOauthState
// ---------------------------------------------------------------------------
describe('cleanupOauthState', () => {
  it('returns deleted count', async () => {
    const db = makeMockDb('5');
    const { logger } = makeLogger();
    const result = await cleanupOauthState(db, logger);
    expect(result.job).toBe('cleanupOauthState');
    expect(result.deleted).toBe(5);
  });

  it('catches errors', async () => {
    const db = makeFailingDb(new Error('timeout'));
    const { logger } = makeLogger();
    const result = await cleanupOauthState(db, logger);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupEmailVerifications
// ---------------------------------------------------------------------------
describe('cleanupEmailVerifications', () => {
  it('returns deleted count', async () => {
    const db = makeMockDb('12');
    const { logger } = makeLogger();
    const result = await cleanupEmailVerifications(db, logger);
    expect(result.job).toBe('cleanupEmailVerifications');
    expect(result.deleted).toBe(12);
  });

  it('catches errors', async () => {
    const db = makeFailingDb(new Error('oops'));
    const { logger } = makeLogger();
    const result = await cleanupEmailVerifications(db, logger);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupPasswordResets
// ---------------------------------------------------------------------------
describe('cleanupPasswordResets', () => {
  it('returns deleted count', async () => {
    const db = makeMockDb('1');
    const { logger } = makeLogger();
    const result = await cleanupPasswordResets(db, logger);
    expect(result.job).toBe('cleanupPasswordResets');
    expect(result.deleted).toBe(1);
  });

  it('catches errors', async () => {
    const db = makeFailingDb(new Error('gone'));
    const { logger } = makeLogger();
    const result = await cleanupPasswordResets(db, logger);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupExpiredSessions
// ---------------------------------------------------------------------------
describe('cleanupExpiredSessions', () => {
  it('returns deleted count', async () => {
    const db = makeMockDb('99');
    const { logger } = makeLogger();
    const result = await cleanupExpiredSessions(db, logger);
    expect(result.job).toBe('cleanupExpiredSessions');
    expect(result.deleted).toBe(99);
  });

  it('catches errors', async () => {
    const db = makeFailingDb(new Error('gone'));
    const { logger } = makeLogger();
    const result = await cleanupExpiredSessions(db, logger);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// purgeArchivedEndUsers
// ---------------------------------------------------------------------------
describe('purgeArchivedEndUsers', () => {
  it('returns deleted count', async () => {
    const db = makeMockDb('3');
    const { logger } = makeLogger();
    const result = await purgeArchivedEndUsers(db, logger);
    expect(result.job).toBe('purgeArchivedEndUsers');
    expect(result.deleted).toBe(3);
  });

  it('catches errors', async () => {
    const db = makeFailingDb(new Error('disk full'));
    const { logger } = makeLogger();
    const result = await purgeArchivedEndUsers(db, logger);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupAuditLog
// ---------------------------------------------------------------------------
describe('cleanupAuditLog', () => {
  it('returns deleted count', async () => {
    const db = makeMockDb('500');
    const { logger } = makeLogger();
    const result = await cleanupAuditLog(db, logger, 90);
    expect(result.job).toBe('cleanupAuditLog');
    expect(result.deleted).toBe(500);
  });

  it('passes retentionDays to the query (execute called once)', async () => {
    const db = makeMockDb('0');
    const { logger } = makeLogger();
    await cleanupAuditLog(db, logger, 30);
    expect(vi.mocked(db.execute)).toHaveBeenCalledOnce();
  });

  it('logs retentionDays in the info record', async () => {
    const db = makeMockDb('10');
    const { logger, infoCalls } = makeLogger();
    await cleanupAuditLog(db, logger, 45);
    const info = infoCalls[0] as { retentionDays: number; msg: string };
    expect(info.retentionDays).toBe(45);
  });

  it('catches errors', async () => {
    const db = makeFailingDb(new Error('gone'));
    const { logger } = makeLogger();
    const result = await cleanupAuditLog(db, logger, 90);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: every job returns a valid JobResult shape
// ---------------------------------------------------------------------------
describe('all jobs return valid JobResult shape', () => {
  type JobWithDb = (db: Database, l: CronLogger) => Promise<JobResult>;

  const cases: Array<{ name: string; fn: JobWithDb }> = [
    { name: 'cleanupMagicLinks', fn: cleanupMagicLinks },
    { name: 'cleanupHandoffTokens', fn: cleanupHandoffTokens },
    { name: 'cleanupOauthState', fn: cleanupOauthState },
    { name: 'cleanupEmailVerifications', fn: cleanupEmailVerifications },
    { name: 'cleanupPasswordResets', fn: cleanupPasswordResets },
    { name: 'cleanupExpiredSessions', fn: cleanupExpiredSessions },
    { name: 'purgeArchivedEndUsers', fn: purgeArchivedEndUsers },
    { name: 'cleanupAuditLog', fn: (db, l) => cleanupAuditLog(db, l, 90) },
  ];

  for (const { name, fn } of cases) {
    it(`${name}: shape is correct on success`, async () => {
      const db = makeMockDb('42');
      const { logger } = makeLogger();
      const result = await fn(db, logger);
      expect(result.job).toBe(name);
      expect(result.deleted).toBe(42);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it(`${name}: shape is correct on error`, async () => {
      const db = makeFailingDb(new Error('test failure'));
      const { logger } = makeLogger();
      const result = await fn(db, logger);
      expect(result.job).toBe(name);
      expect(result.deleted).toBe(0);
      expect(typeof result.durationMs).toBe('number');
    });
  }
});
