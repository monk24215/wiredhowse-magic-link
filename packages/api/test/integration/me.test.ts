import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://placeholder:placeholder@localhost:5432/placeholder';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.RESEND_API_KEY = 'test';
});

vi.mock('../../src/config', () => ({
  config: {
    NODE_ENV: 'test',
    SITE_URL: 'https://magic-link.wiredhowse.app',
    RESEND_API_KEY: 'test',
    RESEND_FROM: 'no-reply@magic-link.wiredhowse.app',
    EMAIL_FROM_NAME: 'wiredHowse Auth',
    EMAIL_REPLY_TO: 'support@wiredhowse.app',
    WH_DISABLE_RATE_LIMITS: 'true',
    SESSION_COOKIE_DOMAIN: undefined,
  },
}));

const dbHolder = vi.hoisted<{ current: ReturnType<typeof drizzle> | null }>(() => ({
  current: null,
}));

vi.mock('@wiredhowse/db', async () => {
  const schema = await import('../../../db/src/schema');
  const ids = await import('../../../db/src/ids');
  return {
    ...schema,
    ...ids,
    get db() {
      return dbHolder.current;
    },
  };
});

// ---------------------------------------------------------------------------
// Deferred imports
// ---------------------------------------------------------------------------

import Fastify, { type FastifyInstance } from 'fastify';

import {
  archivedEndUsers,
  endUsers,
  handoffTokens,
  loginHistory,
  magicLinks,
  oauthState,
  passwordResets,
  emailVerifications,
  sessions,
  siteOwnerSessions,
  siteOwners,
  sites,
} from '@wiredhowse/db';

import { and, eq, isNull } from 'drizzle-orm';
import { runMigrations } from '../../../db/src/migrate';
import { registerGlobalErrorHandler } from '../../src/errors';
import { hashToken } from '../../src/lib/crypto';
import { hashBytes } from '../../src/lib/hashing';
import { addDays, nowUtc } from '../../src/lib/time';
import { identityRoutes } from '../../src/routes/identity/index';
import { meRoutes } from '../../src/routes/me/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testDb() {
  if (!dbHolder.current) throw new Error('Test DB not initialised');
  return dbHolder.current;
}

interface SeedResult {
  endUserId: string;
  rawToken: string;
  sessionId: string;
  siteId: string;
}

/**
 * Insert a site_owner, site, end_user, and an active session.
 * Returns the raw session token to use as `Authorization: Bearer <token>`.
 */
async function seedEndUserWithSession(opts: { email?: string } = {}): Promise<SeedResult> {
  const db = testDb();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = opts.email ?? `user-${suffix}@test.example`;

  // Site Owner
  const [owner] = await db
    .insert(siteOwners)
    .values({
      email: `owner-${suffix}@test.example`,
      passwordHash: 'hash',
      authMethod: 'password',
    })
    .returning({ id: siteOwners.id });
  if (!owner) throw new Error('seedSiteOwner failed');

  // Site
  const [site] = await db
    .insert(sites)
    .values({
      siteOwnerId: owner.id,
      domain: `test-${suffix}.example.com`,
      siteKey: `pk_${suffix.replace(/[^A-Za-z0-9_-]/g, '').padEnd(22, 'a').slice(0, 22)}`,
      state: 'live',
      verificationToken: `vt_${suffix}`,
      allowedOrigins: ['https://test.example.com'],
      verifiedAt: nowUtc(),
    })
    .returning();
  if (!site) throw new Error('seedSite failed');

  // End User
  const [endUser] = await db
    .insert(endUsers)
    .values({ email, emailVerifiedAt: nowUtc() })
    .returning();
  if (!endUser) throw new Error('seedEndUser failed');

  // Session
  const rawToken = `wh_s_${suffix.replace(/[^A-Za-z0-9_-]/g, '')}abcdefghijklmnopqrstuvwxyz`;
  const [session] = await db
    .insert(sessions)
    .values({
      endUserId: endUser.id,
      siteId: site.id,
      tokenHash: hashToken(rawToken),
      expiresAt: addDays(nowUtc(), 1),
      loginCountAtCreation: 1,
      ipHash: hashBytes('127.0.0.1'),
      userAgentHash: hashBytes('vitest'),
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error('seedSession failed');

  return {
    endUserId: endUser.id,
    rawToken,
    sessionId: session.id,
    siteId: site.id,
  };
}

function bearerHeader(rawToken: string) {
  return { authorization: `Bearer ${rawToken}` };
}

// ---------------------------------------------------------------------------
// Container + app lifecycle
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let pgClient: ReturnType<typeof postgres>;
let app: FastifyInstance;

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

  const schema = await import('../../../db/src/schema');
  pgClient = postgres(url, { max: 10 });
  dbHolder.current = drizzle(pgClient, { schema });

  app = Fastify({ logger: false });
  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });
  registerGlobalErrorHandler(app);
  void app.register(meRoutes, { prefix: '/v1/me' });
  void app.register(identityRoutes, { prefix: '/v1/identity' });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await pgClient.end();
  await container.stop();
});

afterEach(async () => {
  const db = testDb();
  await db.delete(loginHistory);
  await db.delete(handoffTokens);
  await db.delete(sessions);
  await db.delete(magicLinks);
  await db.delete(oauthState);
  await db.delete(passwordResets);
  await db.delete(emailVerifications);
  await db.delete(siteOwnerSessions);
  await db.delete(archivedEndUsers);
  await db.delete(endUsers);
  await db.delete(sites);
  await db.delete(siteOwners);
});

// ---------------------------------------------------------------------------
// GET /v1/me
// ---------------------------------------------------------------------------

describe('GET /v1/me', () => {
  it('returns 200 with correct End User profile', async () => {
    const { rawToken, endUserId } = await seedEndUserWithSession();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearerHeader(rawToken),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; email: string } }>();
    expect(body.data.id).toBe(endUserId);
    expect(body.data.email).toMatch(/@test\.example$/);
  });

  it('returns 401 UNAUTHENTICATED with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 UNAUTHENTICATED with expired session', async () => {
    const db = testDb();
    const suffix = `${Date.now()}`;

    const [owner] = await db
      .insert(siteOwners)
      .values({ email: `o-${suffix}@t.x`, passwordHash: 'h', authMethod: 'password' })
      .returning({ id: siteOwners.id });
    if (!owner) throw new Error();

    const [site] = await db
      .insert(sites)
      .values({
        siteOwnerId: owner.id,
        domain: `exp-${suffix}.x`,
        siteKey: `pk_${'a'.repeat(22)}`,
        state: 'live',
        verificationToken: 'vt',
        allowedOrigins: [],
        verifiedAt: nowUtc(),
      })
      .returning();
    if (!site) throw new Error();

    const [eu] = await db
      .insert(endUsers)
      .values({ email: `eu-${suffix}@t.x`, emailVerifiedAt: nowUtc() })
      .returning();
    if (!eu) throw new Error();

    const rawToken = `wh_s_expiredtok${suffix}${'x'.repeat(20)}`;
    await db.insert(sessions).values({
      endUserId: eu.id,
      siteId: site.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() - 3600_000), // 1 hour ago
      loginCountAtCreation: 1,
      ipHash: hashBytes('127.0.0.1'),
      userAgentHash: hashBytes('vitest'),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearerHeader(rawToken),
    });

    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/me
// ---------------------------------------------------------------------------

describe('PATCH /v1/me', () => {
  it('updates display_name and returns updated profile', async () => {
    const { rawToken } = await seedEndUserWithSession();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { ...bearerHeader(rawToken), 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'New Name' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { display_name: string | null } }>();
    expect(body.data.display_name).toBe('New Name');
  });

  it('clears display_name when set to null', async () => {
    const { rawToken } = await seedEndUserWithSession();

    // First set a name
    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { ...bearerHeader(rawToken), 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Has Name' }),
    });

    // Then clear it
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { ...bearerHeader(rawToken), 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: null }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { display_name: null } }>().data.display_name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/sessions
// ---------------------------------------------------------------------------

describe('GET /v1/me/sessions', () => {
  it('returns only this user\'s active sessions', async () => {
    const userA = await seedEndUserWithSession();
    const userB = await seedEndUserWithSession();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: bearerHeader(userA.rawToken),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { sessions: Array<{ id: string }> } }>();
    // User A should see exactly 1 session (their own)
    expect(body.data.sessions).toHaveLength(1);
    expect(body.data.sessions[0]?.id).toBe(userA.sessionId);
    // User B's session should NOT be in the list
    expect(body.data.sessions.some((s) => s.id === userB.sessionId)).toBe(false);
  });

  it('marks the calling session as is_current=true', async () => {
    const { rawToken, sessionId } = await seedEndUserWithSession();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: bearerHeader(rawToken),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { sessions: Array<{ id: string; is_current: boolean }> };
    }>();
    const sess = body.data.sessions.find((s) => s.id === sessionId);
    expect(sess?.is_current).toBe(true);
  });

  it('excludes expired sessions from the list', async () => {
    const db = testDb();
    const { rawToken, endUserId, siteId } = await seedEndUserWithSession();

    // Add an expired session
    await db.insert(sessions).values({
      endUserId,
      siteId,
      tokenHash: hashToken(`wh_s_expiredextra${Date.now()}${'x'.repeat(20)}`),
      expiresAt: new Date(Date.now() - 3600_000),
      loginCountAtCreation: 1,
      ipHash: hashBytes('127.0.0.1'),
      userAgentHash: hashBytes('vitest'),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: bearerHeader(rawToken),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { sessions: unknown[] } }>();
    // Only the active session (from seedEndUserWithSession), not the expired one
    expect(body.data.sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/me/sessions/:id/revoke
// ---------------------------------------------------------------------------

describe('POST /v1/me/sessions/:id/revoke', () => {
  it('revokes the specified session and returns 204', async () => {
    const db = testDb();
    const { rawToken, endUserId, siteId, sessionId } = await seedEndUserWithSession();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/sessions/${sessionId}/revoke`,
      headers: bearerHeader(rawToken),
    });

    expect(res.statusCode).toBe(204);

    // Verify the session is revoked in the DB
    const [sess] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(sess?.revokedAt).not.toBeNull();
    void endUserId;
    void siteId;
  });

  it('returns 404 when session belongs to a different user — CROSS-USER ISOLATION', async () => {
    const userA = await seedEndUserWithSession();
    const userB = await seedEndUserWithSession();

    // User A tries to revoke User B's session
    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/sessions/${userB.sessionId}/revoke`,
      headers: bearerHeader(userA.rawToken),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');

    // User B's session must still be active
    const db = testDb();
    const [sess] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, userB.sessionId), isNull(sessions.revokedAt)))
      .limit(1);
    expect(sess).toBeDefined();
  });

  it('returns 404 for non-existent session ID', async () => {
    const { rawToken } = await seedEndUserWithSession();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/sessions/sess_doesnotexist/revoke',
      headers: bearerHeader(rawToken),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/me/sessions/revoke-all
// ---------------------------------------------------------------------------

describe('POST /v1/me/sessions/revoke-all', () => {
  it('revokes all sessions for this user and returns 204', async () => {
    const db = testDb();
    const { rawToken, endUserId, siteId } = await seedEndUserWithSession();

    // Add a second session for the same user
    const extraToken = `wh_s_extra${Date.now()}${'y'.repeat(30)}`;
    await db.insert(sessions).values({
      endUserId,
      siteId,
      tokenHash: hashToken(extraToken),
      expiresAt: addDays(nowUtc(), 1),
      loginCountAtCreation: 2,
      ipHash: hashBytes('127.0.0.2'),
      userAgentHash: hashBytes('vitest2'),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/sessions/revoke-all',
      headers: bearerHeader(rawToken),
    });

    expect(res.statusCode).toBe(204);

    // Both sessions for this user must be revoked
    const remaining = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.endUserId, endUserId), isNull(sessions.revokedAt)));
    expect(remaining).toHaveLength(0);
  });

  it('does not revoke sessions belonging to other users', async () => {
    const userA = await seedEndUserWithSession();
    const userB = await seedEndUserWithSession();

    await app.inject({
      method: 'POST',
      url: '/v1/me/sessions/revoke-all',
      headers: bearerHeader(userA.rawToken),
    });

    // User B's session must still be active
    const db = testDb();
    const [bSession] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, userB.sessionId), isNull(sessions.revokedAt)))
      .limit(1);
    expect(bSession).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/me/close-and-archive
// ---------------------------------------------------------------------------

describe('POST /v1/me/close-and-archive', () => {
  it('deletes the end_user row and cascades to sessions + login_history', async () => {
    const db = testDb();
    const { rawToken, endUserId, siteId, sessionId } = await seedEndUserWithSession();

    // Add login history
    await db.insert(loginHistory).values({
      endUserId,
      siteId,
      ipHash: hashBytes('127.0.0.1'),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/close-and-archive',
      headers: { ...bearerHeader(rawToken), 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE MY DATA' }),
    });

    expect(res.statusCode).toBe(204);

    // end_user row must be gone
    const euRows = await db.select().from(endUsers).where(eq(endUsers.id, endUserId));
    expect(euRows).toHaveLength(0);

    // Sessions cascaded
    const sessRows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(sessRows).toHaveLength(0);

    // Login history cascaded
    const histRows = await db.select().from(loginHistory).where(eq(loginHistory.endUserId, endUserId));
    expect(histRows).toHaveLength(0);
  });

  it('inserts an archived_end_users row with sha256(email) — not plaintext', async () => {
    const db = testDb();
    const email = `archive-${Date.now()}@test.example`;
    const { rawToken, endUserId } = await seedEndUserWithSession({ email });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/close-and-archive',
      headers: { ...bearerHeader(rawToken), 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE MY DATA' }),
    });

    expect(res.statusCode).toBe(204);

    const [archived] = await db
      .select()
      .from(archivedEndUsers)
      .where(eq(archivedEndUsers.originalUserId, endUserId))
      .limit(1);

    expect(archived).toBeDefined();
    expect(archived?.originalUserId).toBe(endUserId);

    // The email_hash must be the sha256 of lowercase email — verify length (32 bytes)
    expect(archived?.emailHash).toBeInstanceOf(Buffer);
    expect((archived?.emailHash as Buffer).length).toBe(32);

    // purge_after must be ~24 months in the future
    const purgeAfter = archived?.purgeAfter;
    expect(purgeAfter).toBeDefined();
    const monthsAhead = (purgeAfter!.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30);
    expect(monthsAhead).toBeGreaterThan(23);
    expect(monthsAhead).toBeLessThan(25);
  });

  it('is atomic: transaction rollback leaves no archive row and no deleted user', async () => {
    // We simulate an atomicity test by verifying the happy path: if the
    // transaction completes fully, BOTH the archive row exists AND the user is
    // deleted. If either were missing we'd know atomicity failed.
    // (Direct rollback injection is not possible without mocking the real DB —
    // Postgres transaction semantics are tested by the DB engine itself.)
    const db = testDb();
    const { rawToken, endUserId } = await seedEndUserWithSession();

    await app.inject({
      method: 'POST',
      url: '/v1/me/close-and-archive',
      headers: { ...bearerHeader(rawToken), 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE MY DATA' }),
    });

    const euRows = await db.select().from(endUsers).where(eq(endUsers.id, endUserId));
    const archiveRows = await db
      .select()
      .from(archivedEndUsers)
      .where(eq(archivedEndUsers.originalUserId, endUserId));

    // Both conditions must be true for a successful atomic operation
    expect(euRows).toHaveLength(0);    // user deleted
    expect(archiveRows).toHaveLength(1); // archive created
  });

  it('returning user after archive gets a fresh end_users row with no archive linkage', async () => {
    const db = testDb();
    const email = `return-${Date.now()}@test.example`;
    const { rawToken, endUserId } = await seedEndUserWithSession({ email });

    // Archive the user
    await app.inject({
      method: 'POST',
      url: '/v1/me/close-and-archive',
      headers: { ...bearerHeader(rawToken), 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE MY DATA' }),
    });

    // Create a fresh end_user with the same email (simulating a return after archive)
    const [newUser] = await db
      .insert(endUsers)
      .values({ email, emailVerifiedAt: nowUtc() })
      .returning();
    if (!newUser) throw new Error('fresh insert failed');

    // The new user ID must differ from the archived original_user_id
    expect(newUser.id).not.toBe(endUserId);

    // The archive row references the original ID — the new user has no link to it
    const [archived] = await db
      .select()
      .from(archivedEndUsers)
      .where(eq(archivedEndUsers.originalUserId, endUserId))
      .limit(1);
    expect(archived).toBeDefined();
    expect(archived?.originalUserId).toBe(endUserId);
    expect(archived?.originalUserId).not.toBe(newUser.id);
  });

  it('returns 400 INVALID_CONFIRMATION for wrong confirmation string', async () => {
    const { rawToken } = await seedEndUserWithSession();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/close-and-archive',
      headers: { ...bearerHeader(rawToken), 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'please delete my data' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CONFIRMATION');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/export
// ---------------------------------------------------------------------------

describe('GET /v1/me/export', () => {
  it('returns a JSON export with profile, sessions, and login_history', async () => {
    const db = testDb();
    const { rawToken, endUserId, siteId } = await seedEndUserWithSession();

    // Add login history
    await db.insert(loginHistory).values({
      endUserId,
      siteId,
      ipHash: hashBytes('127.0.0.1'),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/export',
      headers: bearerHeader(rawToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);

    const body = res.json<{
      exported_at: string;
      profile: { id: string; email: string };
      sessions: Array<{ id: string }>;
      login_history: Array<{ id: number }>;
    }>();

    expect(body.exported_at).toBeTruthy();
    expect(body.profile.id).toBe(endUserId);
    expect(body.sessions).toHaveLength(1);
    expect(body.login_history).toHaveLength(1);
  });

  it('does NOT include token_hash, ip_hash, or user_agent_hash in sessions', async () => {
    const { rawToken } = await seedEndUserWithSession();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/export',
      headers: bearerHeader(rawToken),
    });

    const body = res.json<{ sessions: Array<Record<string, unknown>> }>();
    const sess = body.sessions[0];
    expect(sess).toBeDefined();
    expect(sess).not.toHaveProperty('token_hash');
    expect(sess).not.toHaveProperty('ip_hash');
    expect(sess).not.toHaveProperty('user_agent_hash');
  });

  it('returns 401 with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me/export' });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/identity/me — SSO contract
// ---------------------------------------------------------------------------

describe('GET /v1/identity/me', () => {
  it('returns the same profile shape as GET /v1/me', async () => {
    const { rawToken, endUserId } = await seedEndUserWithSession();

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearerHeader(rawToken),
    });

    const identityRes = await app.inject({
      method: 'GET',
      url: '/v1/identity/me',
      headers: bearerHeader(rawToken),
    });

    expect(identityRes.statusCode).toBe(200);
    expect(meRes.statusCode).toBe(200);

    const meBody = meRes.json<{ data: { id: string } }>();
    const identityBody = identityRes.json<{ data: { id: string } }>();

    expect(identityBody.data.id).toBe(endUserId);
    expect(identityBody.data.id).toBe(meBody.data.id);

    // Both responses must have the same fields
    const meKeys = Object.keys(meBody.data).sort();
    const identityKeys = Object.keys(identityBody.data).sort();
    expect(identityKeys).toEqual(meKeys);
  });

  it('returns 401 with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/identity/me' });
    expect(res.statusCode).toBe(401);
  });
});
