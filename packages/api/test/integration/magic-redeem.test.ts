import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Bootstrap — runs before vi.mock hoisting, sets placeholder env vars so any
// module that validates process.env at import time doesn't throw.
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

// Mutable db holder — set in beforeAll after the testcontainer starts.
// The getter makes the export a live reference so route modules always see
// the current value when they call db.select() etc.
// eslint-disable-next-line prefer-const
const dbHolder = vi.hoisted<{ current: ReturnType<typeof drizzle> | null }>(() => ({
  current: null,
}));

vi.mock('@wiredhowse/db', async () => {
  // Import schema and id helpers directly from source (no DB connection needed)
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

// These are imported through the mocked @wiredhowse/db — resolved by Vitest
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Shorthand to get the test db — throws if not yet initialised
function testDb() {
  if (!dbHolder.current) throw new Error('Test DB not initialised');
  return dbHolder.current;
}

// Seed helpers
async function seedSiteOwner() {
  const db = testDb();
  const [owner] = await db
    .insert(siteOwners)
    .values({
      email: `owner-${Date.now()}@test.example`,
      passwordHash: 'hash',
      authMethod: 'password',
    })
    .returning({ id: siteOwners.id });
  if (!owner) throw new Error('seedSiteOwner: INSERT returned no row');
  return owner.id;
}

async function seedSite(
  siteOwnerId: string,
  state: 'live' | 'disabled' | 'pending_verification' = 'live',
) {
  const db = testDb();
  const [site] = await db
    .insert(sites)
    .values({
      siteOwnerId,
      domain: `test-${Date.now()}.example.com`,
      siteKey: `pk_test${Date.now()}abcdefghijklmnop`,
      state,
      verificationToken: `vt_${Date.now()}`,
      allowedOrigins: ['https://test.example.com'],
    })
    .returning();
  if (!site) throw new Error('seedSite: INSERT returned no row');
  return site;
}

async function seedMagicLink(siteId: string, opts: { expired?: boolean; redeemed?: boolean } = {}) {
  const db = testDb();
  const raw = `wh_ml_TESTTOKEN${Date.now()}`;
  const tokenHash = hashToken(raw);
  const ip = '127.0.0.1';
  const expiresAt = opts.expired
    ? addSeconds(nowUtc(), -60) // 1 min in the past
    : addSeconds(nowUtc(), 900); // 15 min in the future

  const [ml] = await db
    .insert(magicLinks)
    .values({
      email: `user-${Date.now()}@test.example`,
      siteId,
      tokenHash,
      expiresAt,
      redeemedAt: opts.redeemed ? nowUtc() : null,
      requestedIpHash: hashBytes(ip),
      requestedUserAgentHash: hashBytes('vitest'),
    })
    .returning();
  if (!ml) throw new Error('seedMagicLink: INSERT returned no row');
  return { rawToken: raw, ml };
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
  pgClient = postgres(url, { max: 5 });
  dbHolder.current = drizzle(pgClient, { schema });

  app = Fastify({ logger: false });
  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });
  registerGlobalErrorHandler(app);
  void app.register(magicRoutes, { prefix: '/v1/magic' });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await pgClient.end();
  await container.stop();
});

// ---------------------------------------------------------------------------
// GET /v1/magic/preflight
// ---------------------------------------------------------------------------

describe('GET /v1/magic/preflight', () => {
  let siteOwnerId: string;
  let site: typeof sites.$inferSelect;

  beforeEach(async () => {
    siteOwnerId = await seedSiteOwner();
    site = await seedSite(siteOwnerId);
  });

  it('returns 200 with masked email and metadata for a valid token', async () => {
    const { rawToken, ml } = await seedMagicLink(site.id);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/magic/preflight?token=${encodeURIComponent(rawToken)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { email: string; site_domain: string; expires_at: string } }>();
    expect(body.data.email).toMatch(/\*\*\*/);
    expect(body.data.email).not.toContain('@test.example'); // masked
    expect(body.data.site_domain).toBe(site.domain);
    expect(body.data.expires_at).toBe(ml.expiresAt.toISOString());
  });

  it('returns 404 for an expired token', async () => {
    const { rawToken } = await seedMagicLink(site.id, { expired: true });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/magic/preflight?token=${encodeURIComponent(rawToken)}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an already-redeemed token', async () => {
    const { rawToken } = await seedMagicLink(site.id, { redeemed: true });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/magic/preflight?token=${encodeURIComponent(rawToken)}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a token with invalid format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/magic/preflight?token=bad-token',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when token query param is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/magic/preflight' });
    expect(res.statusCode).toBe(404);
  });

  it('sets Cache-Control: no-store', async () => {
    const { rawToken } = await seedMagicLink(site.id);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/magic/preflight?token=${encodeURIComponent(rawToken)}`,
    });

    expect(res.headers['cache-control']).toContain('no-store');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/magic/redeem
// ---------------------------------------------------------------------------

describe('GET /v1/magic/redeem', () => {
  let siteOwnerId: string;
  let site: typeof sites.$inferSelect;

  beforeEach(async () => {
    siteOwnerId = await seedSiteOwner();
    site = await seedSite(siteOwnerId);
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('302-redirects with handoff fragment on a valid first-time redemption', async () => {
    const { rawToken } = await seedMagicLink(site.id);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toMatch(/^https:\/\/test\.example\.com#wh_handoff=wh_ho_/);
  });

  it('creates a session row after successful redemption', async () => {
    const { rawToken } = await seedMagicLink(site.id);

    await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    const rows = await testDb().select().from(sessions);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('creates a handoff_tokens row after successful redemption', async () => {
    const { rawToken } = await seedMagicLink(site.id);

    await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    const rows = await testDb().select().from(handoffTokens);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('creates a login_history row after successful redemption', async () => {
    const { rawToken } = await seedMagicLink(site.id);

    await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    const rows = await testDb().select().from(loginHistory);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('marks the magic link as redeemed after successful redemption', async () => {
    const { rawToken, ml } = await seedMagicLink(site.id);

    await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    const [updated] = await testDb()
      .select({ redeemedAt: magicLinks.redeemedAt })
      .from(magicLinks)
      .where(eq(magicLinks.id, ml.id));
    expect(updated?.redeemedAt).not.toBeNull();
  });

  it('creates an end_user row for a new email', async () => {
    const { rawToken } = await seedMagicLink(site.id);

    const before = await testDb().select().from(endUsers);

    await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    const after = await testDb().select().from(endUsers);
    expect(after.length).toBe(before.length + 1);
  });

  it('reuses existing end_user row for a returning email', async () => {
    // First redemption — creates end_user
    const { rawToken: token1 } = await seedMagicLink(site.id);
    await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(token1)}`,
    });

    // Seed a second link for the same email in the same site
    const [firstUser] = await testDb().select().from(endUsers);
    if (!firstUser) throw new Error('No end_user after first redemption');
    const ml2Raw = `wh_ml_SECOND${Date.now()}`;
    const db = testDb();
    await db.insert(magicLinks).values({
      email: firstUser.email,
      siteId: site.id,
      tokenHash: hashToken(ml2Raw),
      expiresAt: addSeconds(nowUtc(), 900),
      requestedIpHash: hashBytes('127.0.0.1'),
      requestedUserAgentHash: hashBytes('vitest'),
    });

    const countBefore = (await testDb().select().from(endUsers)).length;

    // Second redemption — should reuse the same end_user
    await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(ml2Raw)}`,
    });

    const countAfter = (await testDb().select().from(endUsers)).length;
    expect(countAfter).toBe(countBefore);
  });

  it('assigns a 2h session on first login (0 prior logins)', async () => {
    const { rawToken } = await seedMagicLink(site.id);

    await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    const [sess] = await testDb().select().from(sessions);
    if (!sess) throw new Error('No session row after redemption');
    const durationMs = sess.expiresAt.getTime() - sess.createdAt.getTime();
    const durationHours = durationMs / (1000 * 3600);
    expect(durationHours).toBeCloseTo(2, 0);
  });

  it('sets Cache-Control: no-store on the redirect', async () => {
    const { rawToken } = await seedMagicLink(site.id);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    expect(res.headers['cache-control']).toContain('no-store');
  });

  // ── Error cases ────────────────────────────────────────────────────────────

  it('returns HTML 404 for an expired link', async () => {
    const { rawToken } = await seedMagicLink(site.id, { expired: true });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('expired or already used');
  });

  it('returns HTML 404 for an already-redeemed link', async () => {
    const { rawToken } = await seedMagicLink(site.id, { redeemed: true });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('returns HTML 410 when site is disabled', async () => {
    const disabledSite = await seedSite(siteOwnerId, 'disabled');
    const { rawToken } = await seedMagicLink(disabledSite.id);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
    });

    expect(res.statusCode).toBe(410);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('returns HTML 404 for malformed token format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/magic/redeem?token=noprefix',
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('prevents double-redemption: second request returns 404 HTML', async () => {
    const { rawToken } = await seedMagicLink(site.id);
    const url = `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`;

    const first = await app.inject({ method: 'GET', url });
    expect(first.statusCode).toBe(302);

    const second = await app.inject({ method: 'GET', url });
    expect(second.statusCode).toBe(404);
    expect(second.headers['content-type']).toContain('text/html');
  });

  // ── Transaction rollback ───────────────────────────────────────────────────

  it('transaction rollback on synthetic handoff failure leaves magic link unredeemed', async () => {
    const { rawToken, ml } = await seedMagicLink(site.id);

    // Force generateToken to throw when creating the handoff token
    const cryptoLib = await import('../../src/lib/crypto');
    const originalGenerate = cryptoLib.generateToken;
    vi.spyOn(cryptoLib, 'generateToken').mockImplementation((prefix: string) => {
      if (prefix === 'wh_ho_') throw new Error('Synthetic handoff insert failure');
      return originalGenerate(prefix);
    });

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`,
      });

      // Should surface as a 500 error page (unhandled error class from DB throw)
      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toContain('text/html');

      // The magic link must NOT be marked redeemed
      const [check] = await testDb()
        .select({ redeemedAt: magicLinks.redeemedAt })
        .from(magicLinks)
        .where(eq(magicLinks.id, ml.id));
      expect(check?.redeemedAt).toBeNull();

      // No sessions, handoff tokens, or login history should exist
      const sess = await testDb().select().from(sessions);
      const ho = await testDb().select().from(handoffTokens);
      const hist = await testDb().select().from(loginHistory);
      expect(sess).toHaveLength(0);
      expect(ho).toHaveLength(0);
      expect(hist).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
