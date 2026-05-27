import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — variables that must be available inside vi.mock factories
// ---------------------------------------------------------------------------

const { mockLimit, mockOrderBy, mockUpdateReturning } = vi.hoisted(() => ({
  // Auth middleware:   select().from().innerJoin().where().limit() → mockLimit
  // GET /sessions:     select().from().innerJoin().where().orderBy() → mockOrderBy
  // POST /:id/revoke:  update().set().where().returning()           → mockUpdateReturning
  mockLimit: vi.fn<[], Promise<unknown[]>>().mockResolvedValue([]),
  mockOrderBy: vi.fn<[], Promise<unknown[]>>().mockResolvedValue([]),
  mockUpdateReturning: vi.fn<[], Promise<unknown[]>>().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/config', () => ({
  config: {
    NODE_ENV: 'test',
    WH_DISABLE_RATE_LIMITS: 'true',
    SITE_URL: 'https://magic-link.wiredhowse.app',
    RESEND_API_KEY: 'test',
    RESEND_FROM: 'no-reply@magic-link.wiredhowse.app',
    EMAIL_FROM_NAME: 'wiredHowse Auth',
    EMAIL_REPLY_TO: 'support@wiredhowse.app',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gt: vi.fn(),
  isNull: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
}));

// ---------------------------------------------------------------------------
// DB mock
//
// Chains needed:
//   auth middleware:
//     select().from().innerJoin().where().limit() → mockLimit
//
//   GET /v1/me/sessions:
//     select().from().innerJoin().where().orderBy() → mockOrderBy
//
//   POST /v1/me/sessions/revoke-all:
//     update().set().where()  — awaited directly (non-thenable OK, no returning)
//
//   POST /v1/me/sessions/:id/revoke:
//     update().set().where().returning() → mockUpdateReturning
//
// Both auth and GET /sessions go through innerJoin → where, so the same
// `where` return object needs both `limit` (for auth) and `orderBy` (for
// the route). The route and auth use separate DB calls, so the mockResolvedValueOnce
// staging order matters: auth fires first (in the preHandler), then the route.
// ---------------------------------------------------------------------------

vi.mock('@wiredhowse/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: mockLimit,       // auth middleware: ...limit(1)
            orderBy: mockOrderBy,   // GET /sessions:  ...orderBy(desc(...))
          }),
        }),
        // Direct where without join (fallback, not currently used by these routes)
        where: () => ({
          limit: mockLimit,
          orderBy: mockOrderBy,
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: mockUpdateReturning,
          // Non-thenable — `await update().set().where()` in revoke-all
          // resolves immediately to this object, which is then discarded.
        }),
      }),
    }),
    // These starters exist so sub-plugins (export, close-archive) don't
    // throw "db.X is not a function" during app initialisation.
    insert: () => ({ values: vi.fn().mockResolvedValue([]) }),
    delete: () => ({ where: vi.fn().mockResolvedValue([]) }),
  },
  sessions: {},
  sites: {},
  endUsers: {},
  loginHistory: {},
  archivedEndUsers: {},
  siteOwnerSessions: {},
  siteOwners: {},
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const END_USER = {
  id: 'eu_user001',
  email: 'alice@example.com',
  displayName: null,
  emailVerifiedAt: new Date(),
  metadata: {},
  createdAt: new Date(),
  lastSeenAt: new Date(),
};

const CURRENT_SESSION_ID = 'sess_current_123';

// Auth middleware returns a joined row: { session, endUser }
const AUTH_ROW = { session: { id: CURRENT_SESSION_ID }, endUser: END_USER };

// A valid-looking session token (startsWith 'Bearer wh_s_')
const VALID_TOKEN = 'wh_s_validtoken12345678901234567890123456';

const makeFakeSessionRow = (id: string, siteId = 'st_site001') => ({
  id,
  siteId,
  siteDomain: 'example.com',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 7_200_000),
  lastUsedAt: new Date(),
});

// ---------------------------------------------------------------------------
// Deferred imports — must come after vi.mock registrations
// ---------------------------------------------------------------------------

const { registerGlobalErrorHandler } = await import('../../src/errors');
const { meRoutes } = await import('../../src/routes/me/index');

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
  const app = Fastify({ logger: false });
  registerGlobalErrorHandler(app);
  void app.register(meRoutes, { prefix: '/v1/me' });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/me/sessions', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns 200 with empty sessions array when no active sessions', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]); // auth succeeds
    mockOrderBy.mockResolvedValueOnce([]);        // no sessions found

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { sessions: unknown[] } }>();
    expect(body.data.sessions).toEqual([]);
  });

  it('returns sessions with is_current=true for the calling session', async () => {
    const rows = [
      makeFakeSessionRow(CURRENT_SESSION_ID),
      makeFakeSessionRow('sess_other'),
    ];
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);
    mockOrderBy.mockResolvedValueOnce(rows);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        sessions: Array<{ id: string; is_current: boolean; site_domain: string }>;
      };
    }>();
    expect(body.data.sessions).toHaveLength(2);
    const current = body.data.sessions.find((s) => s.id === CURRENT_SESSION_ID);
    const other = body.data.sessions.find((s) => s.id === 'sess_other');
    expect(current?.is_current).toBe(true);
    expect(other?.is_current).toBe(false);
  });

  it('includes site_domain and site_id in each session', async () => {
    const rows = [makeFakeSessionRow('sess_abc', 'st_site001')];
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);
    mockOrderBy.mockResolvedValueOnce(rows);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { sessions: Array<{ id: string; site_id: string; site_domain: string }> };
    }>();
    expect(body.data.sessions[0]?.site_domain).toBe('example.com');
    expect(body.data.sessions[0]?.site_id).toBe('st_site001');
  });

  it('returns 401 UNAUTHENTICATED with no Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me/sessions' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 UNAUTHENTICATED when session is not found in DB', async () => {
    mockLimit.mockResolvedValueOnce([]); // no session found

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /v1/me/sessions/revoke-all', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns 204 No Content', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]); // auth succeeds

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/sessions/revoke-all',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(204);
  });
});

describe('POST /v1/me/sessions/:id/revoke', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns 204 when session is found and revoked', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'sess_target' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/sessions/sess_target/revoke',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 NOT_FOUND when session not found or belongs to another user', async () => {
    // The WHERE clause includes AND end_user_id = user.id.
    // If the session belongs to someone else, the UPDATE returns no rows.
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);
    mockUpdateReturning.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/sessions/sess_belongs_to_user_b/revoke',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('returns 404 NOT_FOUND for an already-revoked session', async () => {
    // The WHERE clause includes AND revoked_at IS NULL → already revoked → no rows
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);
    mockUpdateReturning.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/sessions/sess_already_revoked/revoke',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
