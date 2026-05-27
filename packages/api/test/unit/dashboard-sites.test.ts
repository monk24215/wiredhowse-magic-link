import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Bootstrap env vars before any config import
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

// ---------------------------------------------------------------------------
// DB mock strategy
//
// All DB queries are intercepted by a single mockDbQuery function.
// Each call consumes one entry from the response queue (mockResponses).
// Use `queueDbResponse(value)` to stage responses in test setup.
//
// DB call order for each route:
//   - requireSiteOwnerSession:
//       1. db.select().from(siteOwnerSessions).innerJoin(siteOwners,...).where(...).limit(1)
//       2. db.update(siteOwnerSessions).set({...}).where(...)     ← mockUpdateChain
//
//   - POST /sites:
//       3. db.select({count}).from(sites).where(...)              ← awaited directly (no .limit)
//       4. db.select({id}).from(sites).where(...).limit(1)        ← domain uniqueness
//       5. db.insert(sites).values({...}).returning()             ← mockInsertReturning
//
//   - GET /sites/:id, PATCH /sites/:id, DELETE /sites/:id:
//       3. db.select().from(sites).where(...).limit(1)
//
//   - DELETE: also update + delete after
// ---------------------------------------------------------------------------

const mockResponses: Array<unknown[]> = [];

function queueDbResponse(...rows: unknown[]) {
  mockResponses.push(rows);
}

function nextDbResponse(): Promise<unknown[]> {
  const next = mockResponses.shift() ?? [];
  return Promise.resolve(next);
}

// The where() mock returns an object that is both awaitable (for queries without
// .limit()) and has a .limit() method for queries that use it.
const whereResult = () => ({
  limit: () => nextDbResponse(),
  then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
    nextDbResponse().then(resolve, reject),
});

vi.mock('@wiredhowse/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () => nextDbResponse(),
          }),
        }),
        where: whereResult,
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => nextDbResponse(),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
        // Support .where(...).returning() for PATCH update
        returning: () => nextDbResponse(),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve([]),
    }),
  },
  siteOwners: {},
  siteOwnerSessions: {},
  sites: {},
  sessions: {},
  loginHistory: {},
  emailVerifications: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gt: vi.fn(),
  isNull: vi.fn(),
  count: vi.fn().mockReturnValue('count()'),
  max: vi.fn().mockReturnValue('max()'),
}));

vi.mock('../../src/services/rate-limit', () => ({
  checkDomainVerifyPerSite: vi
    .fn()
    .mockResolvedValue({ allowed: true, current: 1, limit: 1, resetAt: 9_999_999_999 }),
  setRateLimitHeaders: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  default: {
    resolveTxt: vi.fn().mockRejectedValue(new Error('ENOTFOUND')),
  },
}));

// ---------------------------------------------------------------------------
// Deferred imports — must come after vi.mock registrations
// ---------------------------------------------------------------------------

const { dashboardRoutes } = await import('../../src/routes/dashboard/index');
const { registerGlobalErrorHandler } = await import('../../src/errors');

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const OWNER = {
  id: 'so_owner001',
  email: 'owner@example.com',
  passwordHash: 'hash',
  authMethod: 'password',
  emailVerifiedAt: new Date('2024-01-01'),
  googleSub: null,
  displayName: 'Test Owner',
  createdAt: new Date('2024-01-01'),
  lastLoginAt: null,
  failedLoginCount: 0,
  lockedUntil: null,
};

/**
 * The auth middleware (requireSiteOwnerSession) returns a joined row:
 * { session: { id, expiresAt }, siteOwner: { ...OWNER } }
 */
const OWNER_SESSION_ROW = {
  session: {
    id: 'dsess_test001',
    expiresAt: new Date(Date.now() + 86400 * 1000 * 30), // 30 days from now
  },
  siteOwner: OWNER,
};

const SITE = {
  id: 'st_site001',
  siteOwnerId: OWNER.id,
  domain: 'mysite.example.com',
  siteKey: 'pk_sitekey123456789012345',
  state: 'live' as const,
  verificationToken: 'vt_abc123',
  verificationMethod: 'dns',
  verifiedAt: new Date('2024-01-02'),
  allowedOrigins: ['https://mysite.example.com'],
  disabledAt: null,
  createdAt: new Date('2024-01-02'),
};

const COOKIE = 'wh_owner_session=wh_owner_session_test_value';

// CSRF double-submit cookie + header for mutation requests.
const CSRF_TOKEN = 'dashboard-unit-test-csrf';
// Combined cookie string: session + CSRF
const AUTHED_COOKIE = `${COOKIE}; wh_csrf=${encodeURIComponent(CSRF_TOKEN)}`;
const CSRF_HEADER = { 'x-csrf-token': CSRF_TOKEN };

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('onSend', (req, reply, _p, done) => {
    void reply.header('X-Request-Id', req.id);
    done();
  });
  registerGlobalErrorHandler(app);
  void app.register(dashboardRoutes, { prefix: '/v1/dashboard' });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dashboard-sites unit tests', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    // Clear the response queue before each test
    mockResponses.length = 0;
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    // resetAllMocks (not clearAllMocks) to also flush the mockResolvedValueOnce queue —
    // clearAllMocks only clears call history, leaving unconsumed Once values that bleed
    // into the next test's auth mock and produce spurious 500s.
    vi.resetAllMocks();
  });

  // ── POST /v1/dashboard/sites ─────────────────────────────────────────────

  describe('POST /v1/dashboard/sites', () => {
    it('returns 201 on successful site creation', async () => {
      // Call sequence for POST /sites:
      // 1. Auth middleware select (innerJoin → .limit(1))
      // 2. Count sites (awaited directly — no .limit)
      // 3. Domain uniqueness (.limit(1))
      // 4. Insert site (.returning())
      const newSite = { ...SITE, domain: 'newsite.example.com', state: 'pending_verification' as const };
      queueDbResponse(OWNER_SESSION_ROW);  // 1. auth
      queueDbResponse({ count: 0 });       // 2. count
      queueDbResponse();                   // 3. domain not found
      queueDbResponse(newSite);            // 4. insert returns site

      const res = await app.inject({
        method: 'POST',
        url: '/v1/dashboard/sites',
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
        body: JSON.stringify({ domain: 'newsite.example.com' }),
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ data: { site: { domain: string; state: string } } }>();
      expect(body.data.site.domain).toBe('newsite.example.com');
      expect(body.data.site.state).toBe('pending_verification');
    });

    it('returns 400 SITE_LIMIT_REACHED when count is 3', async () => {
      // 1. Auth, 2. Count = 3 (limit reached before domain check)
      queueDbResponse(OWNER_SESSION_ROW);   // 1. auth
      queueDbResponse({ count: 3 });        // 2. count

      const res = await app.inject({
        method: 'POST',
        url: '/v1/dashboard/sites',
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
        body: JSON.stringify({ domain: 'fourthsite.example.com' }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('SITE_LIMIT_REACHED');
    });

    it('returns 409 DOMAIN_ALREADY_REGISTERED when domain exists', async () => {
      // 1. Auth, 2. Count = 0, 3. Domain exists
      queueDbResponse(OWNER_SESSION_ROW);        // 1. auth
      queueDbResponse({ count: 0 });             // 2. count
      queueDbResponse({ id: 'st_other' });       // 3. domain found

      const res = await app.inject({
        method: 'POST',
        url: '/v1/dashboard/sites',
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
        body: JSON.stringify({ domain: 'taken.example.com' }),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('DOMAIN_ALREADY_REGISTERED');
    });

    it('returns 400 VALIDATION_ERROR for invalid domain', async () => {
      // Auth runs, then validation fails before any DB query
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth

      const res = await app.inject({
        method: 'POST',
        url: '/v1/dashboard/sites',
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
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

  // ── GET /v1/dashboard/sites/:id ──────────────────────────────────────────

  describe('GET /v1/dashboard/sites/:id', () => {
    it('returns site with snippet_tag when found', async () => {
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth
      queueDbResponse(SITE);              // 2. site lookup

      const res = await app.inject({
        method: 'GET',
        url: `/v1/dashboard/sites/${SITE.id}`,
        headers: { cookie: AUTHED_COOKIE, ...CSRF_HEADER },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: {
          site: {
            id: string;
            snippet_tag: string;
            verification_token: string;
          };
          verification_instructions: { dns: { record_type: string } };
        };
      }>();
      expect(body.data.site.id).toBe(SITE.id);
      expect(body.data.site.snippet_tag).toContain(SITE.siteKey);
      expect(body.data.site.snippet_tag).toContain('<script');
      expect(body.data.verification_instructions.dns.record_type).toBe('TXT');
    });

    it('returns 404 NOT_FOUND when cross-tenant (select returns empty)', async () => {
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth
      queueDbResponse();                  // 2. site not found

      const res = await app.inject({
        method: 'GET',
        url: '/v1/dashboard/sites/st_other_owner',
        headers: { cookie: AUTHED_COOKIE, ...CSRF_HEADER },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    });

    it('returns 401 UNAUTHENTICATED with no cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/dashboard/sites/${SITE.id}`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ── PATCH /v1/dashboard/sites/:id ────────────────────────────────────────

  describe('PATCH /v1/dashboard/sites/:id', () => {
    it('returns 400 VALIDATION_ERROR when state=pending_verification is sent (schema rejects it)', async () => {
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/dashboard/sites/${SITE.id}`,
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
        // updateSiteSchema only allows state: 'live' | 'disabled'
        body: JSON.stringify({ state: 'pending_verification' }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when trying to enable an unverified site to live', async () => {
      const unverifiedSite = { ...SITE, state: 'disabled' as const, verifiedAt: null };
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth
      queueDbResponse(unverifiedSite);    // 2. site lookup

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/dashboard/sites/${SITE.id}`,
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
        body: JSON.stringify({ state: 'live' }),
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 404 NOT_FOUND for cross-tenant access', async () => {
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth
      queueDbResponse();                  // 2. site not found

      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/dashboard/sites/st_other_owner',
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
        body: JSON.stringify({ allowed_origins: ['https://evil.example.com'] }),
      });

      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    });

    it('returns 401 UNAUTHENTICATED with no cookie', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/dashboard/sites/${SITE.id}`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowed_origins: [] }),
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ── DELETE /v1/dashboard/sites/:id ───────────────────────────────────────

  describe('DELETE /v1/dashboard/sites/:id', () => {
    it('returns 400 INVALID_CONFIRMATION without confirmation body', async () => {
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/dashboard/sites/${SITE.id}`,
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
        body: JSON.stringify({}),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CONFIRMATION');
    });

    it('returns 400 INVALID_CONFIRMATION when confirmation value is wrong', async () => {
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/dashboard/sites/${SITE.id}`,
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
        body: JSON.stringify({ confirmation: 'REMOVE' }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CONFIRMATION');
    });

    it('returns 404 NOT_FOUND for cross-tenant access', async () => {
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth
      queueDbResponse();                  // 2. site not found

      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/dashboard/sites/st_other_owner',
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      });

      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    });

    it('returns 401 UNAUTHENTICATED with no cookie', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/dashboard/sites/${SITE.id}`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ── GET /v1/dashboard/account ─────────────────────────────────────────────

  describe('GET /v1/dashboard/account', () => {
    it('returns current owner profile', async () => {
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth

      const res = await app.inject({
        method: 'GET',
        url: '/v1/dashboard/account',
        headers: { cookie: AUTHED_COOKIE, ...CSRF_HEADER },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: { id: string; email: string } }>();
      expect(body.data.id).toBe(OWNER.id);
      expect(body.data.email).toBe(OWNER.email);
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

  // ── PATCH /v1/dashboard/account ───────────────────────────────────────────

  describe('PATCH /v1/dashboard/account', () => {
    it('returns 400 VALIDATION_ERROR when new_password given without current_password', async () => {
      queueDbResponse(OWNER_SESSION_ROW); // 1. auth

      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/dashboard/account',
        headers: { cookie: AUTHED_COOKIE, 'content-type': 'application/json', ...CSRF_HEADER },
        body: JSON.stringify({ new_password: 'newSecurePass123' }),
      });

      expect(res.statusCode).toBe(400);
      // Schema refine: current_password required when new_password is set
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
});
