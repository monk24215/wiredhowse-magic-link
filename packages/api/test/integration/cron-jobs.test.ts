/**
 * Integration tests for cron job functions.
 *
 * Spins up a real Postgres container via testcontainers, runs migrations,
 * seeds specific rows, runs each job, then asserts the correct rows were
 * deleted and the correct rows were preserved.
 *
 * Each test uses afterEach to truncate tables, so tests are independent.
 */

// ---------------------------------------------------------------------------
// Bootstrap — placeholder env so module-level validators don't crash
// ---------------------------------------------------------------------------

import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://placeholder:placeholder@localhost:5432/placeholder';
  process.env.AUDIT_LOG_RETENTION_DAYS = '90';
  process.env.HEALTHZ_PORT = '3099';
});

// ---------------------------------------------------------------------------
// Real DB wiring (testcontainers)
// ---------------------------------------------------------------------------

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@wiredhowse/db';

import * as schema from '../../../db/src/schema';
import { runMigrations } from '../../../db/src/migrate';

// ---------------------------------------------------------------------------
// Job imports
// ---------------------------------------------------------------------------

import { cleanupAuditLog } from '../../src/cron/jobs/cleanup-audit-log';
import { cleanupEmailVerifications } from '../../src/cron/jobs/cleanup-email-verifications';
import { cleanupExpiredSessions } from '../../src/cron/jobs/cleanup-expired-sessions';
import { cleanupHandoffTokens } from '../../src/cron/jobs/cleanup-handoff-tokens';
import { cleanupMagicLinks } from '../../src/cron/jobs/cleanup-magic-links';
import { cleanupOauthState } from '../../src/cron/jobs/cleanup-oauth-state';
import { cleanupPasswordResets } from '../../src/cron/jobs/cleanup-password-resets';
import { purgeArchivedEndUsers } from '../../src/cron/jobs/purge-archived-end-users';
import type { CronLogger } from '../../src/cron/jobs/types';

// ---------------------------------------------------------------------------
// Container + DB lifecycle
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let pgClient: ReturnType<typeof postgres>;
let db: Database;

const silentLogger: CronLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'testpass',
      POSTGRES_DB: 'testdb',
    })
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const url = `postgres://postgres:testpass@${container.getHost()}:${container.getMappedPort(5432)}/testdb`;
  await runMigrations(url);
  pgClient = postgres(url, { max: 5 });
  // Cast to Database — same schema, same runtime shape; structural equivalence.
  db = drizzle(pgClient, { schema }) as unknown as Database;
}, 120_000);

afterAll(async () => {
  await pgClient.end();
  await container.stop();
});

afterEach(async () => {
  // Truncate in FK-safe order (children first)
  await db.execute(schema.sql`TRUNCATE TABLE
    audit_log,
    archived_end_users,
    login_history,
    handoff_tokens,
    sessions,
    magic_links,
    oauth_state,
    email_verifications,
    password_resets,
    site_owner_sessions,
    sites,
    end_users,
    site_owners
    RESTART IDENTITY CASCADE`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedSiteOwner(): Promise<string> {
  const rows = await db
    .insert(schema.siteOwners)
    .values({
      email: `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@test.example`,
      passwordHash: 'hash',
      authMethod: 'password',
    })
    .returning({ id: schema.siteOwners.id });
  const row = rows[0];
  if (!row) throw new Error('seedSiteOwner failed');
  return row.id;
}

async function seedSite(ownerId: string): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rows = await db
    .insert(schema.sites)
    .values({
      siteOwnerId: ownerId,
      domain: `test-${suffix}.example.com`,
      siteKey: `pk_test${suffix}`.slice(0, 32),
      state: 'live',
      verificationToken: `vt_${suffix}`,
      allowedOrigins: ['https://test.example.com'],
    })
    .returning({ id: schema.sites.id });
  const row = rows[0];
  if (!row) throw new Error('seedSite failed');
  return row.id;
}

async function seedEndUser(): Promise<string> {
  const rows = await db
    .insert(schema.endUsers)
    .values({ email: `user-${Date.now()}-${Math.random().toString(36).slice(2)}@test.example` })
    .returning({ id: schema.endUsers.id });
  const row = rows[0];
  if (!row) throw new Error('seedEndUser failed');
  return row.id;
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3_600_000);
}

function daysAgo(d: number): Date {
  return new Date(Date.now() - d * 86_400_000);
}

// ---------------------------------------------------------------------------
// cleanupMagicLinks
// ---------------------------------------------------------------------------

describe('cleanupMagicLinks', () => {
  it('deletes magic_links created >24 hours ago', async () => {
    const ownerId = await seedSiteOwner();
    const siteId = await seedSite(ownerId);

    // Two stale rows (25 hours old)
    await db.insert(schema.magicLinks).values([
      {
        email: 'a@test.example',
        siteId,
        tokenHash: Buffer.from('cml_hash1'),
        createdAt: hoursAgo(25),
        expiresAt: hoursAgo(24),
        requestedIpHash: Buffer.from('ip1'),
        requestedUserAgentHash: Buffer.from('ua1'),
      },
      {
        email: 'b@test.example',
        siteId,
        tokenHash: Buffer.from('cml_hash2'),
        createdAt: hoursAgo(26),
        expiresAt: hoursAgo(25),
        requestedIpHash: Buffer.from('ip2'),
        requestedUserAgentHash: Buffer.from('ua2'),
      },
    ]);

    // One fresh row (1 hour old — should NOT be deleted)
    await db.insert(schema.magicLinks).values({
      email: 'c@test.example',
      siteId,
      tokenHash: Buffer.from('cml_hash3'),
      createdAt: hoursAgo(1),
      expiresAt: new Date(Date.now() + 600_000),
      requestedIpHash: Buffer.from('ip3'),
      requestedUserAgentHash: Buffer.from('ua3'),
    });

    const result = await cleanupMagicLinks(db, silentLogger);
    expect(result.deleted).toBe(2);

    const remaining = await db.select().from(schema.magicLinks);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.email).toBe('c@test.example');
  });

  it('is idempotent — running twice deletes nothing the second time', async () => {
    const ownerId = await seedSiteOwner();
    const siteId = await seedSite(ownerId);

    await db.insert(schema.magicLinks).values({
      email: 'stale@test.example',
      siteId,
      tokenHash: Buffer.from('cml_idem'),
      createdAt: hoursAgo(30),
      expiresAt: hoursAgo(29),
      requestedIpHash: Buffer.from('ip'),
      requestedUserAgentHash: Buffer.from('ua'),
    });

    const first = await cleanupMagicLinks(db, silentLogger);
    const second = await cleanupMagicLinks(db, silentLogger);
    expect(first.deleted).toBe(1);
    expect(second.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupHandoffTokens
// ---------------------------------------------------------------------------

describe('cleanupHandoffTokens', () => {
  it('deletes handoff_tokens created >1 hour ago', async () => {
    const ownerId = await seedSiteOwner();
    const siteId = await seedSite(ownerId);
    const endUserId = await seedEndUser();

    const sess = await db
      .insert(schema.sessions)
      .values({
        endUserId,
        siteId,
        tokenHash: Buffer.from('cht_sess1'),
        expiresAt: new Date(Date.now() + 7_200_000),
        loginCountAtCreation: 1,
        ipHash: Buffer.from('ip'),
        userAgentHash: Buffer.from('ua'),
      })
      .returning({ id: schema.sessions.id });
    const sessionId = sess[0]?.id;
    if (!sessionId) throw new Error('seed session failed');

    // Stale handoff token (2 hours old)
    await db.insert(schema.handoffTokens).values({
      sessionId,
      tokenHash: Buffer.from('cht_stale'),
      rawSessionToken: 'wh_s_stale',
      createdAt: hoursAgo(2),
      expiresAt: hoursAgo(1),
    });

    // Fresh handoff token (30 minutes old — should NOT be deleted)
    await db.insert(schema.handoffTokens).values({
      sessionId,
      tokenHash: Buffer.from('cht_fresh'),
      rawSessionToken: 'wh_s_fresh',
      createdAt: new Date(Date.now() - 30 * 60_000),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });

    const result = await cleanupHandoffTokens(db, silentLogger);
    expect(result.deleted).toBe(1);

    const remaining = await db.select().from(schema.handoffTokens);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.rawSessionToken).toBe('wh_s_fresh');
  });
});

// ---------------------------------------------------------------------------
// cleanupOauthState
// ---------------------------------------------------------------------------

describe('cleanupOauthState', () => {
  it('deletes oauth_state rows created >1 hour ago', async () => {
    // Stale (2 hours old)
    await db.insert(schema.oauthState).values({
      state: 'cos_stale_state',
      createdAt: hoursAgo(2),
      expiresAt: hoursAgo(1),
    });

    // Fresh (5 minutes old)
    await db.insert(schema.oauthState).values({
      state: 'cos_fresh_state',
      createdAt: new Date(Date.now() - 5 * 60_000),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });

    const result = await cleanupOauthState(db, silentLogger);
    expect(result.deleted).toBe(1);

    const remaining = await db.select().from(schema.oauthState);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.state).toBe('cos_fresh_state');
  });
});

// ---------------------------------------------------------------------------
// cleanupEmailVerifications
// ---------------------------------------------------------------------------

describe('cleanupEmailVerifications', () => {
  it('deletes email_verifications whose expires_at is >7 days past', async () => {
    const ownerId = await seedSiteOwner();

    // Stale: expired 8 days ago
    await db.insert(schema.emailVerifications).values({
      siteOwnerId: ownerId,
      email: 'cev_stale@test.example',
      tokenHash: Buffer.from('cev_hash_stale'),
      createdAt: daysAgo(9),
      expiresAt: daysAgo(8),
    });

    // Within grace: expired 3 days ago (not yet 7 days past expiry — preserve)
    await db.insert(schema.emailVerifications).values({
      siteOwnerId: ownerId,
      email: 'cev_recent@test.example',
      tokenHash: Buffer.from('cev_hash_recent'),
      createdAt: daysAgo(4),
      expiresAt: daysAgo(3),
    });

    const result = await cleanupEmailVerifications(db, silentLogger);
    expect(result.deleted).toBe(1);

    const remaining = await db.select().from(schema.emailVerifications);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.email).toBe('cev_recent@test.example');
  });
});

// ---------------------------------------------------------------------------
// cleanupPasswordResets
// ---------------------------------------------------------------------------

describe('cleanupPasswordResets', () => {
  it('deletes password_resets whose expires_at is >7 days past', async () => {
    const ownerId = await seedSiteOwner();

    // Stale: expired 10 days ago
    await db.insert(schema.passwordResets).values({
      siteOwnerId: ownerId,
      tokenHash: Buffer.from('cpr_hash_stale'),
      createdAt: daysAgo(11),
      expiresAt: daysAgo(10),
    });

    // Within grace: expired 2 days ago
    await db.insert(schema.passwordResets).values({
      siteOwnerId: ownerId,
      tokenHash: Buffer.from('cpr_hash_recent'),
      createdAt: daysAgo(3),
      expiresAt: daysAgo(2),
    });

    const result = await cleanupPasswordResets(db, silentLogger);
    expect(result.deleted).toBe(1);

    const remaining = await db.select().from(schema.passwordResets);
    expect(remaining).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// cleanupExpiredSessions
// ---------------------------------------------------------------------------

describe('cleanupExpiredSessions', () => {
  it('deletes sessions expired >7 days ago and preserves recent/active', async () => {
    const ownerId = await seedSiteOwner();
    const siteId = await seedSite(ownerId);
    const endUserId = await seedEndUser();

    // Very stale: expired 10 days ago
    await db.insert(schema.sessions).values({
      endUserId,
      siteId,
      tokenHash: Buffer.from('ces_stale'),
      createdAt: daysAgo(12),
      expiresAt: daysAgo(10),
      loginCountAtCreation: 1,
      ipHash: Buffer.from('ip'),
      userAgentHash: Buffer.from('ua'),
    });

    // Expired recently (3 days ago — within 7-day grace period)
    await db.insert(schema.sessions).values({
      endUserId,
      siteId,
      tokenHash: Buffer.from('ces_recent'),
      createdAt: daysAgo(4),
      expiresAt: daysAgo(3),
      loginCountAtCreation: 1,
      ipHash: Buffer.from('ip'),
      userAgentHash: Buffer.from('ua'),
    });

    // Active: expires in the future
    await db.insert(schema.sessions).values({
      endUserId,
      siteId,
      tokenHash: Buffer.from('ces_active'),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7_200_000),
      loginCountAtCreation: 1,
      ipHash: Buffer.from('ip'),
      userAgentHash: Buffer.from('ua'),
    });

    const result = await cleanupExpiredSessions(db, silentLogger);
    expect(result.deleted).toBe(1);

    const remaining = await db.select().from(schema.sessions);
    expect(remaining).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// purgeArchivedEndUsers
// ---------------------------------------------------------------------------

describe('purgeArchivedEndUsers', () => {
  it('purges archived_end_users where purge_after < now()', async () => {
    // Past purge_after (should be deleted)
    await db.insert(schema.archivedEndUsers).values({
      emailHash: Buffer.from('pau_hash_past'),
      originalUserId: 'pau_user_past',
      archivedAt: daysAgo(800),
      purgeAfter: daysAgo(70),
      sessionSummary: {},
    });

    // Future purge_after (should be preserved)
    await db.insert(schema.archivedEndUsers).values({
      emailHash: Buffer.from('pau_hash_future'),
      originalUserId: 'pau_user_future',
      archivedAt: daysAgo(30),
      purgeAfter: new Date(Date.now() + 86_400_000 * 700),
      sessionSummary: {},
    });

    const result = await purgeArchivedEndUsers(db, silentLogger);
    expect(result.deleted).toBe(1);

    const remaining = await db.select().from(schema.archivedEndUsers);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.originalUserId).toBe('pau_user_future');
  });

  it('is idempotent', async () => {
    await db.insert(schema.archivedEndUsers).values({
      emailHash: Buffer.from('pau_hash_once'),
      originalUserId: 'pau_user_once',
      archivedAt: daysAgo(800),
      purgeAfter: daysAgo(10),
      sessionSummary: {},
    });

    const first = await purgeArchivedEndUsers(db, silentLogger);
    const second = await purgeArchivedEndUsers(db, silentLogger);
    expect(first.deleted).toBe(1);
    expect(second.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupAuditLog
// ---------------------------------------------------------------------------

describe('cleanupAuditLog', () => {
  it('deletes audit_log rows older than retentionDays', async () => {
    // 91 days old — past the 90-day retention
    await db.insert(schema.auditLog).values({
      occurredAt: daysAgo(91),
      actorType: 'system',
      action: 'cal_old_event',
    });

    // 89 days old — within retention (should be preserved)
    await db.insert(schema.auditLog).values({
      occurredAt: daysAgo(89),
      actorType: 'system',
      action: 'cal_recent_event',
    });

    const result = await cleanupAuditLog(db, silentLogger, 90);
    expect(result.deleted).toBe(1);

    const remaining = await db.select().from(schema.auditLog);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.action).toBe('cal_recent_event');
  });

  it('respects custom retentionDays (30)', async () => {
    // 31 days old — past 30-day retention
    await db.insert(schema.auditLog).values({
      occurredAt: daysAgo(31),
      actorType: 'system',
      action: 'cal_old_30',
    });

    // 29 days old — within 30-day retention
    await db.insert(schema.auditLog).values({
      occurredAt: daysAgo(29),
      actorType: 'system',
      action: 'cal_recent_30',
    });

    const result = await cleanupAuditLog(db, silentLogger, 30);
    expect(result.deleted).toBe(1);

    const remaining = await db.select().from(schema.auditLog);
    expect(remaining).toHaveLength(1);
  });

  it('is idempotent', async () => {
    await db.insert(schema.auditLog).values({
      occurredAt: daysAgo(100),
      actorType: 'system',
      action: 'cal_very_old',
    });

    const first = await cleanupAuditLog(db, silentLogger, 90);
    const second = await cleanupAuditLog(db, silentLogger, 90);
    expect(first.deleted).toBe(1);
    expect(second.deleted).toBe(0);
  });
});
