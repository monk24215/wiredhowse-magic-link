import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Bootstrap — placeholder env vars to satisfy module-level env validation
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://placeholder:placeholder@localhost:5432/placeholder';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.RESEND_API_KEY = 'test';
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/config', () => ({
  config: {
    NODE_ENV: 'test',
    SITE_URL: 'https://magic-link.wiredhowse.app',
    RESEND_API_KEY: 'test',
    RESEND_FROM: 'no-reply@magic-link.wiredhowse.app',
    EMAIL_FROM_NAME: 'wiredHowse Auth',
    EMAIL_REPLY_TO: 'support@wiredhowse.app',
    WH_DISABLE_RATE_LIMITS: 'true',
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
// Deferred imports — must come after vi.mock registrations
// ---------------------------------------------------------------------------

import Fastify, { type FastifyInstance } from 'fastify';

import {
  endUsers,
  handoffTokens,
  loginHistory,
  magicLinks,
  sessions,
  siteOwners,
  sites,
} from '@wiredhowse/db';

import { runMigrations } from '../../../db/src/migrate';
import { registerGlobalErrorHandler } from '../../src/errors';
import { hashToken } from '../../src/lib/crypto';
import { hashBytes } from '../../src/lib/hashing';
import { addSeconds, nowUtc } from '../../src/lib/time';
import { magicRoutes } from '../../src/routes/magic/index';
import { handoffExchangeRoutes } from '../../src/routes/snippet/handoff-exchange';
import { sessionCheckRoutes } from '../../src/routes/snippet/session-check';
import { signOutRoutes } from '../../src/routes/snippet/sign-out';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testDb() {
  if (!dbHolder.current) throw new Error('Test DB not initialised');
  return dbHolder.current;
}

async function seedSiteOwner() {
  const db = testDb();
  const [owner] = await db
    .insert(siteOwners)
    .values({
      email: `owner-${Date.now()}-${Math.random()}@test.example`,
      passwordHash: 'hash',
      authMethod: 'password',
    })
    .returning({ id: siteOwners.id });
  if (!owner) throw new Error('seedSiteOwner: INSERT returned no row');
  return owner.id;
}

async function seedSite(
  siteOwnerId: string,
  opts: { state?: 'live' | 'disabled' | 'pending_verification'; key?: string } = {},
) {
  const db = testDb();
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [site] = await db
    .insert(sites)
    .values({
      siteOwnerId,
      domain: `test-${uniqueSuffix}.example.com`,
      siteKey: opts.key ?? `pk_test${uniqueSuffix}abcdefghijklm`.slice(0, 32),
      state: opts.state ?? 'live',
      verificationToken: `vt_${uniqueSuffix}`,
      allowedOrigins: ['https://test.example.com'],
    })
    .returning();
  if (!site) throw new Error('seedSite: INSERT returned no row');
  return site;
}

async function seedEndUser(email: string) {
  const db = testDb();
  const [user] = await db.insert(endUsers).values({ email, emailVerifiedAt: nowUtc() }).returning();
  if (!user) throw new Error('seedEndUser: INSERT returned no row');
  return user;
}

async function seedMagicLink(siteId: string, email: string) {
  const db = testDb();
  const raw = `wh_ml_${Date.now()}${Math.random().toString(36).slice(2)}`;
  const tokenHash = hashToken(raw);
  const expiresAt = addSeconds(nowUtc(), 900);

  const [ml] = await db
    .insert(magicLinks)
    .values({
      email,
      siteId,
      tokenHash,
      expiresAt,
      requestedIpHash: hashBytes('127.0.0.1'),
      requestedUserAgentHash: hashBytes('vitest'),
    })
    .returning();
  if (!ml) throw new Error('seedMagicLink: INSERT returned no row');
  return { rawToken: raw, ml };
}

async function seedSession(
  siteId: string,
  endUserId: string,
  opts: { expired?: boolean; revoked?: boolean; expiresInSec?: number } = {},
) {
  const db = testDb();
  const rawToken = `wh_s_${Date.now()}${Math.random().toString(36).slice(2, 42)}`;
  const tokenHash = hashToken(rawToken);

  const expiresAt =
    opts.expired
      ? addSeconds(nowUtc(), -3600)
      : addSeconds(nowUtc(), opts.expiresInSec ?? 7200);

  const revokedAt = opts.revoked ? nowUtc() : null;

  const [sess] = await db
    .insert(sessions)
    .values({
      endUserId,
      siteId,
      tokenHash,
      expiresAt,
      revokedAt,
      loginCountAtCreation: 1,
      ipHash: hashBytes('127.0.0.1'),
      userAgentHash: hashBytes('vitest'),
    })
    .returning();
  if (!sess) throw new Error('seedSession: INSERT returned no row');
  return { rawToken, session: sess };
}

/** Extract the wh_ho_ token from a redirect Location header fragment. */
function extractHandoffToken(location: string): string {
  const match = location.match(/#wh_handoff=(wh_ho_[^&]+)$/);
  const token = match?.[1];
  if (!token) throw new Error(`No wh_handoff fragment in location: ${location}`);
  return token;
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
  void app.register(magicRoutes, { prefix: '/v1/magic' });
  void app.register(handoffExchangeRoutes, { prefix: '/v1/snippet' });
  void app.register(sessionCheckRoutes, { prefix: '/v1/snippet' });
  void app.register(signOutRoutes, { prefix: '/v1/snippet' });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await pgClient.end();
  await container.stop();
});

afterEach(async () => {
  const db = testDb();
  // Delete in FK dependency order
  await db.delete(loginHistory);
  await db.delete(handoffTokens);
  await db.delete(sessions);
  await db.delete(magicLinks);
  await db.delete(endUsers);
  await db.delete(sites);
  await db.delete(siteOwners);
});

// ---------------------------------------------------------------------------
// Full lifecycle: magic-link → redeem → exchange → check → sign-out → check
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/sign-out — full lifecycle', () => {
  it('sign-out revokes the session and a subsequent check returns valid:false', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const email = `user-${Date.now()}@test.example`;

    // 1. Seed and redeem a magic link
    const { rawToken: mlToken } = await seedMagicLink(site.id, email);
    const redeemRes = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(mlToken)}`,
    });
    expect(redeemRes.statusCode).toBe(302);
    const hoToken = extractHandoffToken(redeemRes.headers.location as string);

    // 2. Exchange the handoff token for a session token
    const exchangeRes = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: hoToken }),
    });
    expect(exchangeRes.statusCode).toBe(200);
    const sessionToken = exchangeRes.json<{ data: { session_token: string } }>().data.session_token;

    // 3. Check the session — must be valid at this point
    const preCheckRes = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ token: sessionToken }),
    });
    expect(preCheckRes.statusCode).toBe(200);
    expect(preCheckRes.json<{ data: { valid: boolean } }>().data.valid).toBe(true);

    // 4. Sign out
    const signOutRes = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
        authorization: `Bearer ${sessionToken}`,
      },
    });
    expect(signOutRes.statusCode).toBe(200);
    expect(signOutRes.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);

    // 5. Check the session again — must be invalid now (revoked)
    const postCheckRes = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ token: sessionToken }),
    });
    expect(postCheckRes.statusCode).toBe(200);
    expect(postCheckRes.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  it('sign-out sets revoked_at in the DB', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const endUser = await seedEndUser(`user-${Date.now()}@test.example`);
    const { rawToken } = await seedSession(site.id, endUser.id);

    const db = testDb();

    // Confirm not revoked yet (only one session in DB after afterEach cleanup)
    const [before] = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .limit(1);
    expect(before?.revokedAt).toBeNull();

    await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
        authorization: `Bearer ${rawToken}`,
      },
    });

    const [after] = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .limit(1);
    expect(after?.revokedAt).not.toBeNull();
    expect(after?.revokedAt).toBeInstanceOf(Date);
  });

  it('sign-out is idempotent — calling it twice returns 200 both times', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const endUser = await seedEndUser(`user-${Date.now()}@test.example`);
    const { rawToken } = await seedSession(site.id, endUser.id);

    const firstRes = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
        authorization: `Bearer ${rawToken}`,
      },
    });
    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);

    // Second call — session already revoked
    const secondRes = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
        authorization: `Bearer ${rawToken}`,
      },
    });
    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);
  });

  it('cross-site token is NOT revoked when presented to the wrong site', async () => {
    // Create two sites for the same owner
    const ownerId = await seedSiteOwner();
    const siteA = await seedSite(ownerId);
    const siteB = await seedSite(ownerId, { key: 'pk_siteB_testonly99999999999' });

    const endUser = await seedEndUser(`user-${Date.now()}@test.example`);

    // Seed a session on Site A
    const { rawToken } = await seedSession(siteA.id, endUser.id);

    // Attempt sign-out via Site B — should still return 200 (idempotent)
    // but the session on Site A must NOT be revoked
    const signOutRes = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': siteB.siteKey,
        origin: 'https://test.example.com',
        authorization: `Bearer ${rawToken}`,
      },
    });
    expect(signOutRes.statusCode).toBe(200);
    expect(signOutRes.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);

    // Verify the session on Site A is still alive
    const checkRes = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': siteA.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ token: rawToken }),
    });
    expect(checkRes.statusCode).toBe(200);
    expect(checkRes.json<{ data: { valid: boolean } }>().data.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth / header checks
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/sign-out — auth and header checks', () => {
  let ownerId: string;
  let site: typeof sites.$inferSelect;

  beforeEach(async () => {
    ownerId = await seedSiteOwner();
    site = await seedSite(ownerId);
  });

  it('returns 401 UNAUTHENTICATED when Authorization header is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
        // no authorization header
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 200 { signed_out: true } for a malformed token (no DB update)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
        authorization: 'Bearer not-a-valid-wh_s-token',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);
  });

  it('returns 200 { signed_out: true } for a non-existent valid-format token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
        // wh_s_ format but this token doesn't exist in the DB
        authorization: 'Bearer wh_s_doesnotexist1234567890123456789012345',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);
  });

  it('returns 403 INVALID_SITE_KEY when X-Site-Key is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        origin: 'https://test.example.com',
        authorization: 'Bearer wh_s_doesnotexist1234567890123456789012345',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });

  it('returns 403 ORIGIN_NOT_ALLOWED for unlisted origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': site.siteKey,
        origin: 'https://evil.example.com',
        authorization: 'Bearer wh_s_doesnotexist1234567890123456789012345',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('responds 204 to CORS preflight OPTIONS', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://test.example.com');
  });

  it('sets X-Request-Id on every response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
        authorization: 'Bearer wh_s_doesnotexist1234567890123456789012345',
      },
    });

    expect(res.headers['x-request-id']).toBeTruthy();
  });
});
