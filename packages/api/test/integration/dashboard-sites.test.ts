import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
    SESSION_COOKIE_DOMAIN: undefined,
  },
}));

// Mock DNS to prevent actual DNS lookups in tests (default: fail).
vi.mock('node:dns/promises', () => ({
  default: {
    resolveTxt: vi.fn().mockRejectedValue(new Error('ENOTFOUND')),
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
  oauthState,
  passwordResets,
  emailVerifications,
  sessions,
  siteOwnerSessions,
  siteOwners,
  sites,
} from '@wiredhowse/db';

import { eq } from 'drizzle-orm';
import { runMigrations } from '../../../db/src/migrate';
import { registerGlobalErrorHandler } from '../../src/errors';
import { hashToken } from '../../src/lib/crypto';
import { hashBytes } from '../../src/lib/hashing';
import { addDays, addSeconds, nowUtc } from '../../src/lib/time';
import { dashboardRoutes } from '../../src/routes/dashboard/index';

import dns from 'node:dns/promises';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testDb() {
  if (!dbHolder.current) throw new Error('Test DB not initialised');
  return dbHolder.current;
}

interface SeedOwnerResult {
  ownerId: string;
  cookieValue: string;
  email: string;
}

/**
 * Insert a site_owner and a matching site_owner_sessions row.
 * Returns the cookie value to send as `wh_owner_session=<cookieValue>`.
 */
async function seedSiteOwner(): Promise<SeedOwnerResult> {
  const db = testDb();
  const email = `owner-${Date.now()}-${Math.random().toString(36).slice(2)}@test.example`;

  const [owner] = await db
    .insert(siteOwners)
    .values({
      email,
      passwordHash: 'hash',
      authMethod: 'password',
    })
    .returning({ id: siteOwners.id });
  if (!owner) throw new Error('seedSiteOwner: INSERT returned no row');

  const raw = `wh_owner_session_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tokenHash = hashToken(raw);

  await db.insert(siteOwnerSessions).values({
    siteOwnerId: owner.id,
    tokenHash,
    expiresAt: addDays(nowUtc(), 30),
    ipHash: hashBytes('127.0.0.1'),
    userAgentHash: hashBytes('vitest'),
  });

  return { ownerId: owner.id, cookieValue: raw, email };
}

/**
 * Same as seedSiteOwner but marks the owner's email as verified.
 */
async function seedSiteOwnerVerified(): Promise<SeedOwnerResult> {
  const result = await seedSiteOwner();
  const db = testDb();
  await db
    .update(siteOwners)
    .set({ emailVerifiedAt: nowUtc() })
    .where(eq(siteOwners.id, result.ownerId));
  return result;
}

/**
 * Insert a site for the given owner. Returns the full site row.
 */
async function seedSite(
  siteOwnerId: string,
  opts: {
    state?: 'live' | 'disabled' | 'pending_verification';
    domain?: string;
    verifiedAt?: Date | null;
  } = {},
) {
  const db = testDb();
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const domain = opts.domain ?? `test-${uniqueSuffix}.example.com`;
  const state = opts.state ?? 'live';

  const [site] = await db
    .insert(sites)
    .values({
      siteOwnerId,
      domain,
      siteKey: `pk_${uniqueSuffix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 22)}abcdefgh`.slice(0, 32),
      state,
      verificationToken: `vt_${uniqueSuffix}`,
      allowedOrigins: ['https://test.example.com'],
      verifiedAt: opts.verifiedAt !== undefined ? opts.verifiedAt : state === 'live' ? nowUtc() : null,
    })
    .returning();
  if (!site) throw new Error('seedSite: INSERT returned no row');
  return site;
}

/** Returns a cookie header object for Fastify inject */
function authHeaders(cookieValue: string): { cookie: string } {
  return { cookie: `wh_owner_session=${cookieValue}` };
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
  void app.register(dashboardRoutes, { prefix: '/v1/dashboard' });
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
  await db.delete(oauthState);
  await db.delete(passwordResets);
  await db.delete(emailVerifications);
  await db.delete(siteOwnerSessions);
  await db.delete(sites);
  await db.delete(endUsers);
  await db.delete(siteOwners);
  // Reset DNS mock to default (failing) state after each test
  vi.mocked(dns.resolveTxt).mockRejectedValue(new Error('ENOTFOUND'));
});

// ---------------------------------------------------------------------------
// GET /v1/dashboard/sites
// ---------------------------------------------------------------------------

describe('GET /v1/dashboard/sites', () => {
  it('returns empty array for owner with no sites', async () => {
    const { cookieValue } = await seedSiteOwner();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/sites',
      headers: authHeaders(cookieValue),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { sites: unknown[] } }>();
    expect(body.data.sites).toEqual([]);
  });

  it('returns only sites owned by the current owner — TENANT ISOLATION', async () => {
    const owner1 = await seedSiteOwner();
    const owner2 = await seedSiteOwner();

    await seedSite(owner1.ownerId);
    await seedSite(owner1.ownerId);
    await seedSite(owner2.ownerId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/sites',
      headers: authHeaders(owner1.cookieValue),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { sites: Array<{ id: string }> } }>();
    expect(body.data.sites).toHaveLength(2);
  });

  it('returns list of sites with correct fields', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/sites',
      headers: authHeaders(cookieValue),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        sites: Array<{
          id: string;
          domain: string;
          state: string;
          site_key: string;
          allowed_origins: string[];
        }>;
      };
    }>();
    expect(body.data.sites).toHaveLength(1);
    const returned = body.data.sites[0];
    expect(returned?.id).toBe(site.id);
    expect(returned?.domain).toBe(site.domain);
    expect(returned?.state).toBe(site.state);
    expect(returned?.site_key).toBe(site.siteKey);
    expect(returned?.allowed_origins).toEqual(site.allowedOrigins);
  });

  it('returns 401 UNAUTHENTICATED with no cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/sites',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/dashboard/sites
// ---------------------------------------------------------------------------

describe('POST /v1/dashboard/sites', () => {
  it('creates a site with valid domain, returns 201 with site + verification_instructions', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    // Must have a verified email to be able to create sites? Let's just seed normal.
    void ownerId; // used to satisfy TS; the cookie encodes the owner

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/sites',
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'newsite.example.com' }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: {
        site: {
          id: string;
          domain: string;
          state: string;
          site_key: string;
          verification_token: string;
        };
        verification_instructions: {
          dns: { record_type: string; name: string; value: string };
          meta: { tag: string; placement: string };
        };
      };
    }>();
    expect(body.data.site.domain).toBe('newsite.example.com');
    expect(body.data.site.state).toBe('pending_verification');
    expect(body.data.site.site_key).toMatch(/^pk_/);
    expect(body.data.site.verification_token).toBeTruthy();
    expect(body.data.verification_instructions.dns.record_type).toBe('TXT');
    expect(body.data.verification_instructions.dns.name).toBe(
      '_wiredhowse-verify.newsite.example.com',
    );
    expect(body.data.verification_instructions.meta.tag).toContain('wh-verify');
  });

  it('returns 400 SITE_LIMIT_REACHED when owner already has 3 sites', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    await seedSite(ownerId);
    await seedSite(ownerId);
    await seedSite(ownerId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/sites',
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'fourthsite.example.com' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SITE_LIMIT_REACHED');
  });

  it('returns 409 DOMAIN_ALREADY_REGISTERED if domain taken by any owner', async () => {
    const owner1 = await seedSiteOwner();
    const owner2 = await seedSiteOwner();
    await seedSite(owner1.ownerId, { domain: 'shared.example.com' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/sites',
      headers: { ...authHeaders(owner2.cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'shared.example.com' }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('DOMAIN_ALREADY_REGISTERED');
  });

  it('returns 400 VALIDATION_ERROR for invalid domain', async () => {
    const { cookieValue } = await seedSiteOwner();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/sites',
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'not a domain' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 UNAUTHENTICATED with no cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/sites',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'newsite.example.com' }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/dashboard/sites/:id
// ---------------------------------------------------------------------------

describe('GET /v1/dashboard/sites/:id', () => {
  it('returns site detail including snippet_tag and verification_instructions', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: authHeaders(cookieValue),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        site: {
          id: string;
          domain: string;
          state: string;
          site_key: string;
          snippet_tag: string;
          verification_token: string;
        };
        verification_instructions: {
          dns: { record_type: string; name: string; value: string };
          meta: { tag: string };
        };
      };
    }>();
    expect(body.data.site.id).toBe(site.id);
    expect(body.data.site.snippet_tag).toContain(site.siteKey);
    expect(body.data.site.snippet_tag).toContain('<script');
    expect(body.data.verification_instructions.dns.name).toContain(site.domain);
  });

  it('returns 404 NOT_FOUND for non-existent id', async () => {
    const { cookieValue } = await seedSiteOwner();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/sites/st_doesnotexist000',
      headers: authHeaders(cookieValue),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('returns 404 NOT_FOUND when id belongs to another owner — CROSS-TENANT 404', async () => {
    const owner1 = await seedSiteOwner();
    const owner2 = await seedSiteOwner();
    const site = await seedSite(owner1.ownerId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: authHeaders(owner2.cookieValue),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('returns 401 UNAUTHENTICATED with no cookie', async () => {
    const { ownerId } = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/sites/${site.id}`,
    });

    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/dashboard/sites/:id
// ---------------------------------------------------------------------------

describe('PATCH /v1/dashboard/sites/:id', () => {
  it('updates allowed_origins', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ allowed_origins: ['https://neworigin.example.com'] }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { site: { allowed_origins: string[] } } }>();
    expect(body.data.site.allowed_origins).toEqual(['https://neworigin.example.com']);
  });

  it('transitions state from live → disabled (sets disabledAt)', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId, { state: 'live' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'disabled' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { site: { state: string; disabled_at: string | null } } }>();
    expect(body.data.site.state).toBe('disabled');
    expect(body.data.site.disabled_at).not.toBeNull();
  });

  it('transitions state from disabled → live (only if verified)', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    // Create live then disable it — verifiedAt is set
    const site = await seedSite(ownerId, { state: 'disabled', verifiedAt: nowUtc() });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'live' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { site: { state: string } } }>();
    expect(body.data.site.state).toBe('live');
  });

  it('returns 400 when trying to set state=live on unverified site', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    // Start as disabled with no verifiedAt
    const site = await seedSite(ownerId, { state: 'disabled', verifiedAt: null });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'live' }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 VALIDATION_ERROR for invalid state transition (pending_verification via PATCH)', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId, { state: 'live' });

    // The updateSiteSchema only accepts 'live' | 'disabled', so 'pending_verification'
    // will be caught by schema validation.
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'pending_verification' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 NOT_FOUND for cross-tenant access — CROSS-TENANT 404', async () => {
    const owner1 = await seedSiteOwner();
    const owner2 = await seedSiteOwner();
    const site = await seedSite(owner1.ownerId, { state: 'live' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: { ...authHeaders(owner2.cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ allowed_origins: ['https://evil.example.com'] }),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('returns 401 UNAUTHENTICATED with no cookie', async () => {
    const { ownerId } = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowed_origins: [] }),
    });

    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/dashboard/sites/:id
// ---------------------------------------------------------------------------

describe('DELETE /v1/dashboard/sites/:id', () => {
  it('deletes site and revokes sessions, returns sessions_revoked count', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId);

    // Seed an end user and an active session on this site
    const db = testDb();
    const [endUser] = await db
      .insert(endUsers)
      .values({ email: `user-${Date.now()}@test.example`, emailVerifiedAt: nowUtc() })
      .returning();
    if (!endUser) throw new Error('seedEndUser failed');

    const rawToken = `wh_s_${Date.now()}`;
    await db.insert(sessions).values({
      endUserId: endUser.id,
      siteId: site.id,
      tokenHash: hashToken(rawToken),
      expiresAt: addDays(nowUtc(), 1),
      loginCountAtCreation: 1,
      ipHash: hashBytes('127.0.0.1'),
      userAgentHash: hashBytes('vitest'),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { deleted: boolean; sessions_revoked: number } }>();
    expect(body.data.deleted).toBe(true);
    expect(body.data.sessions_revoked).toBe(1);

    // Verify the site is gone
    const remaining = await db.select().from(sites).where(eq(sites.id, site.id));
    expect(remaining).toHaveLength(0);
  });

  it('returns 400 INVALID_CONFIRMATION without confirmation body', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CONFIRMATION');
  });

  it('returns 404 NOT_FOUND for cross-tenant access — CROSS-TENANT 404', async () => {
    const owner1 = await seedSiteOwner();
    const owner2 = await seedSiteOwner();
    const site = await seedSite(owner1.ownerId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/dashboard/sites/${site.id}`,
      headers: { ...authHeaders(owner2.cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/dashboard/sites/:id/verify
// ---------------------------------------------------------------------------

describe('POST /v1/dashboard/sites/:id/verify', () => {
  it('DNS verification: returns verified=true method=dns when TXT record matches', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId, { state: 'pending_verification', verifiedAt: null });

    // Return the verification token in the TXT record
    vi.mocked(dns.resolveTxt).mockResolvedValueOnce([[site.verificationToken]]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/dashboard/sites/${site.id}/verify`,
      headers: authHeaders(cookieValue),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { verified: boolean; method: string } }>();
    expect(body.data.verified).toBe(true);
    expect(body.data.method).toBe('dns');
  });

  it('meta verification: returns verified=true method=meta when HTML meta tag matches', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId, { state: 'pending_verification', verifiedAt: null });

    // DNS fails, but meta succeeds
    vi.mocked(dns.resolveTxt).mockRejectedValueOnce(new Error('ENOTFOUND'));

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (done) return { done: true, value: undefined };
              done = true;
              const html = `<html><head><meta name="wh-verify" content="${site.verificationToken}"></head></html>`;
              return { done: false, value: new TextEncoder().encode(html) };
            },
            releaseLock: () => undefined,
          };
        },
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/dashboard/sites/${site.id}/verify`,
      headers: authHeaders(cookieValue),
    });

    vi.unstubAllGlobals();

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { verified: boolean; method: string } }>();
    expect(body.data.verified).toBe(true);
    expect(body.data.method).toBe('meta');
  });

  it('both checks fail: returns verified=false with next_check_allowed_at', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId, { state: 'pending_verification', verifiedAt: null });

    // DNS and fetch both fail (default mock already fails; stub fetch to fail too)
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/dashboard/sites/${site.id}/verify`,
      headers: authHeaders(cookieValue),
    });

    vi.unstubAllGlobals();

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { verified: boolean; checked_at: string; next_check_allowed_at: string };
    }>();
    expect(body.data.verified).toBe(false);
    expect(body.data.next_check_allowed_at).toBeTruthy();
  });

  it('returns 404 NOT_FOUND for cross-tenant access — CROSS-TENANT 404', async () => {
    const owner1 = await seedSiteOwner();
    const owner2 = await seedSiteOwner();
    const site = await seedSite(owner1.ownerId, { state: 'pending_verification', verifiedAt: null });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/dashboard/sites/${site.id}/verify`,
      headers: authHeaders(owner2.cookieValue),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/dashboard/sites/:id/clear-sessions
// ---------------------------------------------------------------------------

describe('POST /v1/dashboard/sites/:id/clear-sessions', () => {
  it('revokes all active sessions, returns count', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const db = testDb();
    const [endUser] = await db
      .insert(endUsers)
      .values({ email: `user-${Date.now()}@test.example`, emailVerifiedAt: nowUtc() })
      .returning();
    if (!endUser) throw new Error('seedEndUser failed');

    // Insert 2 active sessions
    for (let i = 0; i < 2; i++) {
      await db.insert(sessions).values({
        endUserId: endUser.id,
        siteId: site.id,
        tokenHash: hashToken(`wh_s_${Date.now()}_${i}`),
        expiresAt: addDays(nowUtc(), 1),
        loginCountAtCreation: 1,
        ipHash: hashBytes('127.0.0.1'),
        userAgentHash: hashBytes('vitest'),
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: `/v1/dashboard/sites/${site.id}/clear-sessions`,
      headers: authHeaders(cookieValue),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { sessions_revoked: number } }>();
    expect(body.data.sessions_revoked).toBe(2);
  });

  it('returns 0 when no active sessions', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/dashboard/sites/${site.id}/clear-sessions`,
      headers: authHeaders(cookieValue),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { sessions_revoked: number } }>();
    expect(body.data.sessions_revoked).toBe(0);
  });

  it('returns 404 NOT_FOUND for cross-tenant access — CROSS-TENANT 404', async () => {
    const owner1 = await seedSiteOwner();
    const owner2 = await seedSiteOwner();
    const site = await seedSite(owner1.ownerId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/dashboard/sites/${site.id}/clear-sessions`,
      headers: authHeaders(owner2.cookieValue),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/dashboard/sites/:id/metrics
// ---------------------------------------------------------------------------

describe('GET /v1/dashboard/sites/:id/metrics', () => {
  it('returns correct active_sessions count', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const db = testDb();

    const [endUser] = await db
      .insert(endUsers)
      .values({ email: `user-${Date.now()}@test.example`, emailVerifiedAt: nowUtc() })
      .returning();
    if (!endUser) throw new Error('seedEndUser failed');

    // Insert 2 active (non-expired, non-revoked) sessions
    for (let i = 0; i < 2; i++) {
      await db.insert(sessions).values({
        endUserId: endUser.id,
        siteId: site.id,
        tokenHash: hashToken(`wh_s_${Date.now()}_${i}`),
        expiresAt: addDays(nowUtc(), 1),
        loginCountAtCreation: 1,
        ipHash: hashBytes('127.0.0.1'),
        userAgentHash: hashBytes('vitest'),
      });
    }

    // Insert 1 expired session (should not count)
    await db.insert(sessions).values({
      endUserId: endUser.id,
      siteId: site.id,
      tokenHash: hashToken(`wh_s_expired_${Date.now()}`),
      expiresAt: addSeconds(nowUtc(), -3600),
      loginCountAtCreation: 1,
      ipHash: hashBytes('127.0.0.1'),
      userAgentHash: hashBytes('vitest'),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/sites/${site.id}/metrics`,
      headers: authHeaders(cookieValue),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { active_sessions: number } }>();
    expect(body.data.active_sessions).toBe(2);
  });

  it('returns correct login counts from login_history rows', async () => {
    const { ownerId, cookieValue } = await seedSiteOwner();
    const site = await seedSite(ownerId);
    const db = testDb();

    const [endUser] = await db
      .insert(endUsers)
      .values({ email: `user-${Date.now()}@test.example`, emailVerifiedAt: nowUtc() })
      .returning();
    if (!endUser) throw new Error('seedEndUser failed');

    // Insert 3 recent login history rows (within last 24 hours)
    for (let i = 0; i < 3; i++) {
      await db.insert(loginHistory).values({
        endUserId: endUser.id,
        siteId: site.id,
        ipHash: hashBytes('127.0.0.1'),
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/sites/${site.id}/metrics`,
      headers: authHeaders(cookieValue),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { logins_24h: number; logins_7d: number; logins_30d: number } }>();
    expect(body.data.logins_24h).toBe(3);
    expect(body.data.logins_7d).toBe(3);
    expect(body.data.logins_30d).toBe(3);
  });

  it('returns 404 NOT_FOUND for cross-tenant access — CROSS-TENANT 404', async () => {
    const owner1 = await seedSiteOwner();
    const owner2 = await seedSiteOwner();
    const site = await seedSite(owner1.ownerId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/sites/${site.id}/metrics`,
      headers: authHeaders(owner2.cookieValue),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/dashboard/account
// ---------------------------------------------------------------------------

describe('GET /v1/dashboard/account', () => {
  it('returns current owner profile', async () => {
    const { ownerId, cookieValue, email } = await seedSiteOwner();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/account',
      headers: authHeaders(cookieValue),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; email: string } }>();
    expect(body.data.id).toBe(ownerId);
    expect(body.data.email).toBe(email);
  });

  it('returns 401 UNAUTHENTICATED with no cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/account',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/dashboard/account
// ---------------------------------------------------------------------------

describe('PATCH /v1/dashboard/account', () => {
  it('updates display_name', async () => {
    const { cookieValue } = await seedSiteOwner();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/dashboard/account',
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'New Name' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { display_name: string | null } }>();
    expect(body.data.display_name).toBe('New Name');
  });

  it('returns 400 VALIDATION_ERROR when new_password given without current_password', async () => {
    const { cookieValue } = await seedSiteOwner();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/dashboard/account',
      headers: { ...authHeaders(cookieValue), 'content-type': 'application/json' },
      body: JSON.stringify({ new_password: 'newSecurePass123' }),
    });

    expect(res.statusCode).toBe(400);
    // Schema validation catches: current_password required when new_password is set
  });

  it('returns 401 UNAUTHENTICATED with no cookie', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/dashboard/account',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Hacker' }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });
});
