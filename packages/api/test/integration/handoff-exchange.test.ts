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
    WH_DISABLE_RATE_LIMITS: undefined,
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

import { eq } from 'drizzle-orm';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testDb() {
  if (!dbHolder.current) throw new Error('Test DB not initialised');
  return dbHolder.current;
}

/** Extract the wh_ho_ token from a redirect Location header fragment. */
function extractHandoffToken(location: string): string {
  const match = location.match(/#wh_handoff=(wh_ho_[^&]+)$/);
  const token = match?.[1];
  if (!token) throw new Error(`No wh_handoff fragment in location: ${location}`);
  return token;
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

async function seedMagicLink(siteId: string, email: string, opts: { expired?: boolean } = {}) {
  const db = testDb();
  const raw = `wh_ml_${Date.now()}${Math.random().toString(36).slice(2)}`;
  const tokenHash = hashToken(raw);
  const expiresAt = opts.expired ? addSeconds(nowUtc(), -60) : addSeconds(nowUtc(), 900);

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
 * Seeds a handoff token directly, bypassing the magic-link flow.
 * Returns the raw handoff token and the session ID it points to.
 */
async function seedHandoffToken(
  siteId: string,
  endUserId: string,
  opts: {
    expired?: boolean;
    redeemed?: boolean;
    rawSessionToken?: string;
  } = {},
) {
  const db = testDb();

  // Create a session first
  const rawSessToken = opts.rawSessionToken ?? 'wh_s_seeded_sess_token_123456789012345678';
  const [sess] = await db
    .insert(sessions)
    .values({
      endUserId,
      siteId,
      tokenHash: hashToken(rawSessToken),
      expiresAt: addSeconds(nowUtc(), 7200),
      loginCountAtCreation: 0,
      ipHash: hashBytes('127.0.0.1'),
      userAgentHash: hashBytes('vitest'),
    })
    .returning({ id: sessions.id });
  if (!sess) throw new Error('seedHandoffToken: session INSERT returned no row');

  const rawHoToken = `wh_ho_${Date.now()}${Math.random().toString(36).slice(2)}`;
  const hoTokenHash = hashToken(rawHoToken);
  const expiresAt = opts.expired
    ? addSeconds(nowUtc(), -60) // already expired
    : addSeconds(nowUtc(), 60);

  const [ht] = await db
    .insert(handoffTokens)
    .values({
      sessionId: sess.id,
      tokenHash: hoTokenHash,
      rawSessionToken: rawSessToken,
      expiresAt,
      redeemedAt: opts.redeemed ? nowUtc() : null,
    })
    .returning({ id: handoffTokens.id });
  if (!ht) throw new Error('seedHandoffToken: INSERT returned no row');

  return { rawHoToken, sessionId: sess.id, handoffId: ht.id };
}

/**
 * Seed a minimal end_user row.
 */
async function seedEndUser(email: string) {
  const db = testDb();
  const [user] = await db.insert(endUsers).values({ email, emailVerifiedAt: nowUtc() }).returning();
  if (!user) throw new Error('seedEndUser: INSERT returned no row');
  return user;
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
  // Use max: 10 so concurrent requests can use separate connections (FOR UPDATE test)
  pgClient = postgres(url, { max: 10 });
  dbHolder.current = drizzle(pgClient, { schema });

  app = Fastify({ logger: false });
  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });
  registerGlobalErrorHandler(app);
  // Register magic routes for full-chain tests
  void app.register(magicRoutes, { prefix: '/v1/magic' });
  void app.register(handoffExchangeRoutes, { prefix: '/v1/snippet' });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await pgClient.end();
  await container.stop();
});

// Clean up after each test so rows don't leak between tests
afterEach(async () => {
  const db = testDb();
  // Delete in dependency order (FKs)
  await db.delete(loginHistory);
  await db.delete(handoffTokens);
  await db.delete(sessions);
  await db.delete(magicLinks);
  await db.delete(endUsers);
  await db.delete(sites);
  await db.delete(siteOwners);
});

// ---------------------------------------------------------------------------
// Full chain: magic-link request → redeem → handoff exchange
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/handoff/exchange — full chain', () => {
  it('returns 200 with session_token and session data after a successful redemption', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const email = `user-${Date.now()}@test.example`;

    // 1. Seed and redeem a magic link to get a real handoff token
    const { rawToken } = await seedMagicLink(site.id, email);

    const redeemRes = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });
    expect(redeemRes.statusCode).toBe(302);

    // Extract handoff token from the redirect Location fragment
    const hoToken = extractHandoffToken(redeemRes.headers.location as string);

    // 2. Exchange the handoff token
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

    const body = exchangeRes.json<{
      data: {
        session_token: string;
        session: {
          id: string;
          expires_at: string;
          end_user: { id: string; email: string; display_name: string | null };
        };
      };
    }>();

    expect(body.data.session_token).toMatch(/^wh_s_/);
    expect(body.data.session.end_user.email).toBe(email);
    expect(body.data.session.expires_at).toBeTruthy();
  });

  it('marks the handoff token as redeemed after a successful exchange', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const email = `user-${Date.now()}@test.example`;

    const { rawToken } = await seedMagicLink(site.id, email);
    const redeemRes = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });
    const hoToken = extractHandoffToken(redeemRes.headers.location as string);

    await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: hoToken }),
    });

    // Verify the handoff token row has redeemed_at set
    const [ht] = await testDb()
      .select({ redeemedAt: handoffTokens.redeemedAt })
      .from(handoffTokens)
      .limit(1);
    expect(ht?.redeemedAt).not.toBeNull();
  });

  it('returns a session_token that hashes to the stored token_hash in sessions', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const email = `user-${Date.now()}@test.example`;

    const { rawToken } = await seedMagicLink(site.id, email);
    const redeemRes = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
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

    const body = exchangeRes.json<{ data: { session_token: string } }>();
    const returnedToken = body.data.session_token;

    // Hash the returned token and compare against the sessions table
    const [sess] = await testDb().select({ tokenHash: sessions.tokenHash }).from(sessions).limit(1);
    expect(sess?.tokenHash).toEqual(hashToken(returnedToken));
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/handoff/exchange — error cases', () => {
  let ownerId: string;
  let site: typeof sites.$inferSelect;
  let endUser: typeof endUsers.$inferSelect;

  beforeEach(async () => {
    ownerId = await seedSiteOwner();
    site = await seedSite(ownerId);
    endUser = await seedEndUser(`user-${Date.now()}@test.example`);
  });

  it('returns 404 HANDOFF_NOT_FOUND for a non-existent token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: 'wh_ho_doesnotexist1234567890123456789012345' }),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('HANDOFF_NOT_FOUND');
  });

  it('returns 404 HANDOFF_NOT_FOUND for an expired handoff token', async () => {
    const { rawHoToken } = await seedHandoffToken(site.id, endUser.id, { expired: true });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: rawHoToken }),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('HANDOFF_NOT_FOUND');
  });

  it('returns 404 HANDOFF_NOT_FOUND for an already-redeemed handoff token', async () => {
    const { rawHoToken } = await seedHandoffToken(site.id, endUser.id, { redeemed: true });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: rawHoToken }),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('HANDOFF_NOT_FOUND');
  });

  it('returns 403 SITE_MISMATCH when handoff belongs to a different site', async () => {
    // Create a second site owned by the same owner
    const otherSite = await seedSite(ownerId, { key: 'pk_othersite1234567890123456' });

    // Seed a handoff token for `site` (not `otherSite`)
    const { rawHoToken } = await seedHandoffToken(site.id, endUser.id);

    // Try to exchange using `otherSite`'s key
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': otherSite.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: rawHoToken }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SITE_MISMATCH');
  });

  it('handoff token is NOT consumed after a SITE_MISMATCH (legitimate site can still exchange it)', async () => {
    const otherSite = await seedSite(ownerId, { key: 'pk_othersite9999999999999999' });
    const { rawHoToken, handoffId } = await seedHandoffToken(site.id, endUser.id);

    // Attempt from the wrong site
    await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': otherSite.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: rawHoToken }),
    });

    // The token must still be unredeemed
    const [ht] = await testDb()
      .select({ redeemedAt: handoffTokens.redeemedAt })
      .from(handoffTokens)
      .where(eq(handoffTokens.id, handoffId));
    expect(ht?.redeemedAt).toBeNull();

    // The correct site CAN still exchange it
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: rawHoToken }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for invalid token format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: 'bad-token' }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 403 INVALID_SITE_KEY when header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: 'wh_ho_doesnotmatter1234567890123456789' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });
});

// ---------------------------------------------------------------------------
// Double-exchange / concurrent race: FOR UPDATE must serialise
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/handoff/exchange — single-use enforcement', () => {
  it('prevents double-exchange: second request returns 404 HANDOFF_NOT_FOUND', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const email = `user-${Date.now()}@test.example`;

    const { rawToken } = await seedMagicLink(site.id, email);
    const redeemRes = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });
    const hoToken = extractHandoffToken(redeemRes.headers.location as string);

    const payload = {
      method: 'POST' as const,
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: hoToken }),
    };

    const first = await app.inject(payload);
    expect(first.statusCode).toBe(200);

    const second = await app.inject(payload);
    expect(second.statusCode).toBe(404);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('HANDOFF_NOT_FOUND');
  });

  it('concurrent exchange race: FOR UPDATE ensures exactly one succeeds', async () => {
    const ownerId = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const email = `user-${Date.now()}@test.example`;

    const { rawToken } = await seedMagicLink(site.id, email);
    const redeemRes = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });
    const hoToken = extractHandoffToken(redeemRes.headers.location as string);

    const payload = {
      method: 'POST' as const,
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': site.siteKey,
        origin: 'https://test.example.com',
      },
      body: JSON.stringify({ handoff_token: hoToken }),
    };

    // Fire two requests concurrently — only one should win
    const [res1, res2] = await Promise.all([app.inject(payload), app.inject(payload)]);

    const statuses = [res1.statusCode, res2.statusCode].sort();
    // Exactly one succeeds (200) and one fails (404)
    expect(statuses).toEqual([200, 404]);

    // The winning response must contain a valid session token
    const winner = res1.statusCode === 200 ? res1 : res2;
    const winnerBody = winner.json<{ data: { session_token: string } }>();
    expect(winnerBody.data.session_token).toMatch(/^wh_s_/);

    // The DB row must be redeemed exactly once
    const [ht] = await testDb()
      .select({ redeemedAt: handoffTokens.redeemedAt })
      .from(handoffTokens)
      .limit(1);
    expect(ht?.redeemedAt).not.toBeNull();
  });
});
