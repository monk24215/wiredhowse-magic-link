import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — variables that must be available inside vi.mock factories
// ---------------------------------------------------------------------------

const { mockLimit, mockReturning } = vi.hoisted(() => ({
  mockLimit: vi.fn<[], Promise<unknown[]>>().mockResolvedValue([]),
  mockReturning: vi.fn<[], Promise<unknown[]>>().mockResolvedValue([]),
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
//   auth middleware:  select().from().innerJoin().where().limit() → mockLimit
//   PATCH /v1/me:     update().set().where().returning()          → mockReturning
// ---------------------------------------------------------------------------

vi.mock('@wiredhowse/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        // direct where (no join) → limit
        where: () => ({ limit: mockLimit }),
        // with innerJoin (auth middleware) → where → limit
        innerJoin: () => ({ where: () => ({ limit: mockLimit }) }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: mockReturning }) }),
    }),
  },
  sessions: {},
  endUsers: {},
  sites: {},
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
  displayName: 'Alice',
  emailVerifiedAt: new Date('2024-01-01T00:00:00Z'),
  metadata: {},
  createdAt: new Date('2024-01-01T00:00:00Z'),
  lastSeenAt: new Date('2024-06-01T00:00:00Z'),
};

// Auth middleware returns a row with session + endUser fields
const AUTH_ROW = { session: { id: 'sess_current' }, endUser: END_USER };

// A valid-looking session token (startsWith 'Bearer wh_s_')
const VALID_TOKEN = 'wh_s_validtoken12345678901234567890123456';

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
  app.addHook('onSend', (_req, reply, _payload, done) => {
    void reply.header('X-Request-Id', _req.id);
    done();
  });
  registerGlobalErrorHandler(app);
  void app.register(meRoutes, { prefix: '/v1/me' });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/me', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns 200 with the End User profile', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; email: string; display_name: string | null } }>();
    expect(body.data.id).toBe(END_USER.id);
    expect(body.data.email).toBe(END_USER.email);
    expect(body.data.display_name).toBe(END_USER.displayName);
  });

  it('returns email_verified_at, created_at, last_seen_at fields', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { email_verified_at: string; created_at: string; last_seen_at: string };
    }>();
    expect(body.data.email_verified_at).toBeTruthy();
    expect(body.data.created_at).toBeTruthy();
    expect(body.data.last_seen_at).toBeTruthy();
  });

  it('returns 401 UNAUTHENTICATED with no Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 UNAUTHENTICATED when session is not found in DB', async () => {
    mockLimit.mockResolvedValueOnce([]); // no session found

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });

  it('sets X-Request-Id on every response', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('PATCH /v1/me', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns 200 with updated display_name', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);
    mockReturning.mockResolvedValueOnce([{ ...END_USER, displayName: 'New Name' }]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_TOKEN}` },
      body: JSON.stringify({ display_name: 'New Name' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { display_name: string | null } }>();
    expect(body.data.display_name).toBe('New Name');
  });

  it('returns 200 with unchanged profile when no fields are sent', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_TOKEN}` },
      body: JSON.stringify({}),
    });

    // No DB update call — body has no recognised fields
    expect(res.statusCode).toBe(200);
    expect(mockReturning).not.toHaveBeenCalled();
    const body = res.json<{ data: { email: string } }>();
    expect(body.data.email).toBe(END_USER.email);
  });

  it('returns 200 when display_name is explicitly null (clears name)', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);
    mockReturning.mockResolvedValueOnce([{ ...END_USER, displayName: null }]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_TOKEN}` },
      body: JSON.stringify({ display_name: null }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { display_name: null } }>();
    expect(body.data.display_name).toBeNull();
  });

  it('returns 400 VALIDATION_ERROR for display_name exceeding 100 chars', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_TOKEN}` },
      body: JSON.stringify({ display_name: 'x'.repeat(101) }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR for non-string display_name', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_TOKEN}` },
      body: JSON.stringify({ display_name: 12345 }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });
});
