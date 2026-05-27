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
    // Rate limits are ON for integration tests — but we use the DB-backed path,
    // not real Redis. Session-check rate limit key is checkSessionCheckPerIp.
    // To avoid needing Redis in integration tests, we mock the rate-limit service.
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

/**
 * Seed a session directly (bypassing the magic-link flow) and return the raw
 * session token so it can be passed to session/check.
 */
async function seedSession(
  siteId: string,
  endUserId: string,
  opts: {
    expired?: boolean;
    revoked?: boolean;
    /** Explicit expiry offset in seconds from now (positive = future). */
    expiresInSec?: number;
  } = {},
) {
  const db = testDb();
  const rawToken = `wh_s_${Date.now()}${Math.random().toString(36).slice(2, 42)}`;
  const tokenHash = hashToken(rawToken);

  const expiresAt =
    opts.expired
      ? addSeconds(nowUtc(), -3600) // 1 hour in the past
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
// Full chain: magic-link → redeem → handoff exchange → session/check
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/session/check — full chain', () => {
  it('returns { valid: true } for a session token obtained via the full magic-link flow', async () => {
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

    // 3. Check the session
    const checkRes = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ token: sessionToken }),
    });

    expect(checkRes.statusCode).toBe(200);
    const body = checkRes.json<{
      data: {
        valid: boolean;
        session: {
          id: string;
          expires_at: string;
          end_user: { id: string; email: string; display_name: string | null };
        };
      };
    }>();
    expect(body.data.valid).toBe(true);
    expect(body.data.session.end_user.email).toBe(email);
    expect(body.data.session.expires_at).toBeTruthy();
  });

  it('updates sessions.last_used_at and end_users.last_seen_at on a valid check', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const email = `user-${Date.now()}@test.example`;

    const { rawToken: mlToken } = await seedMagicLink(site.id, email);
    const redeemRes = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(mlToken)}`,
    });
    const hoToken = extractHandoffToken(redeemRes.headers.location as string);
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
    const sessionToken = exchangeRes.json<{ data: { session_token: string } }>().data.session_token;

    // Capture timestamps before the check
    const before = new Date();

    await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ token: sessionToken }),
    });

    // Verify DB timestamps were refreshed
    const db = testDb();
    const [sess] = await db
      .select({ lastUsedAt: sessions.lastUsedAt })
      .from(sessions)
      .limit(1);
    expect(sess?.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

    const [user] = await db
      .select({ lastSeenAt: endUsers.lastSeenAt })
      .from(endUsers)
      .limit(1);
    expect(user?.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('does NOT update timestamps when the session is invalid', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const endUser = await seedEndUser(`user-${Date.now()}@test.example`);
    const { session: sess } = await seedSession(site.id, endUser.id);

    // Capture the original last_used_at
    const db = testDb();
    const [original] = await db
      .select({ lastUsedAt: sessions.lastUsedAt })
      .from(sessions)
      .limit(1);

    // Send a tampered token (wrong chars after valid prefix)
    const tamperedToken = `${sess.id}XXXXXX_tampered_garbage_padding`;
    await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      // Not a valid wh_s_ token format — treated as valid:false before DB hit
      body: JSON.stringify({ token: tamperedToken }),
    });

    const [after] = await db
      .select({ lastUsedAt: sessions.lastUsedAt })
      .from(sessions)
      .limit(1);
    expect(after?.lastUsedAt).toEqual(original?.lastUsedAt);
  });
});

// ---------------------------------------------------------------------------
// Error cases: seeded sessions directly
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/session/check — invalid session states', () => {
  let ownerId: string;
  let site: typeof sites.$inferSelect;
  let endUser: typeof endUsers.$inferSelect;

  beforeEach(async () => {
    ownerId = await seedSiteOwner();
    site = await seedSite(ownerId);
    endUser = await seedEndUser(`user-${Date.now()}@test.example`);
  });

  it('returns { valid: false } for a non-existent token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ token: 'wh_s_doesnotexist1234567890123456789012345' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  it('returns { valid: false } for an expired session', async () => {
    const { rawToken } = await seedSession(site.id, endUser.id, { expired: true });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ token: rawToken }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  it('returns { valid: false } for a revoked session', async () => {
    const { rawToken } = await seedSession(site.id, endUser.id, { revoked: true });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ token: rawToken }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  it('returns { valid: false } when a token from Site A is checked against Site B', async () => {
    // Create a second site for the same owner
    const otherSite = await seedSite(ownerId, { key: 'pk_othersite9999999999999999' });

    // Seed a valid session for site (not otherSite)
    const { rawToken } = await seedSession(site.id, endUser.id);

    // Present it against otherSite — must be rejected
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': otherSite.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ token: rawToken }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  it('returns { valid: false } when token field is absent from body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  it('returns 200 { valid: true } for a valid session with all expected fields', async () => {
    const { rawToken } = await seedSession(site.id, endUser.id);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ token: rawToken }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        valid: boolean;
        session: {
          id: string;
          expires_at: string;
          end_user: { id: string; email: string; display_name: string | null };
        };
      };
    }>();
    expect(body.data.valid).toBe(true);
    expect(body.data.session.id).toBeTruthy();
    expect(body.data.session.expires_at).toBeTruthy();
    expect(body.data.session.end_user.id).toBe(endUser.id);
    expect(body.data.session.end_user.email).toBe(endUser.email);
  });
});

// ---------------------------------------------------------------------------
// Header / CORS checks
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/session/check — headers', () => {
  it('returns 403 INVALID_SITE_KEY when X-Site-Key is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });

  it('returns 403 ORIGIN_NOT_ALLOWED for unlisted origin', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('responds 204 to CORS preflight OPTIONS', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/snippet/session/check',
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
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({}),
    });

    expect(res.headers['x-request-id']).toBeTruthy();
  });
});
