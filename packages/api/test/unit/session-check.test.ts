import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — registered before any imports that touch these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/config', () => ({
  config: {
    NODE_ENV: 'test',
    WH_DISABLE_RATE_LIMITS: 'true', // Redis bypassed in unit tests
    SITE_URL: 'https://magic-link.wiredhowse.app',
    RESEND_API_KEY: 'test',
    RESEND_FROM: 'no-reply@magic-link.wiredhowse.app',
    EMAIL_FROM_NAME: 'wiredHowse Auth',
    EMAIL_REPLY_TO: 'support@wiredhowse.app',
  },
}));

// Drizzle operators are pass-through in unit tests
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), gt: vi.fn(), isNull: vi.fn() }));

// ---------------------------------------------------------------------------
// DB mock
//
// All `db.select().from().where().limit()` calls share a single mock function.
// Use mockResolvedValueOnce in order to stage results for each sequential call:
//   1st call  → site lookup  (from resolveSite)
//   2nd call  → session lookup
//   3rd call  → end_user lookup (only on valid session)
// ---------------------------------------------------------------------------

const mockSelectLimit = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@wiredhowse/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) }),
    update: () => ({ set: () => ({ where: mockUpdate }) }),
  },
  sites: {},
  sessions: {},
  endUsers: {},
}));

// ---------------------------------------------------------------------------
// Rate-limit mock — controlled per-test via vi.mocked(...)
// ---------------------------------------------------------------------------

vi.mock('../../src/services/rate-limit', () => ({
  checkSessionCheckPerIp: vi
    .fn()
    .mockResolvedValue({ allowed: true, current: 1, limit: 120, resetAt: 9_999_999_999 }),
  setRateLimitHeaders: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Deferred imports — must come after vi.mock registrations
// ---------------------------------------------------------------------------

const { sessionCheckRoutes } = await import('../../src/routes/snippet/session-check');
const rateLimitModule = await import('../../src/services/rate-limit');

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const LIVE_SITE = {
  id: 'st_siteAAAAAAAAA',
  siteKey: 'pk_siteAkey12345678901234',
  domain: 'site-a.example.com',
  state: 'live',
  allowedOrigins: ['https://site-a.example.com'],
};

// A valid raw session token: prefix + base64url chars, length > 36
const VALID_RAW_TOKEN = 'wh_s_validtoken12345678901234567890123456';

const SESSION = {
  id: 'sess_abc123',
  siteId: LIVE_SITE.id,
  endUserId: 'eu_user001',
  tokenHash: Buffer.from('mockhash'),
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 7_200_000), // 2 hr from now
  lastUsedAt: new Date(),
  revokedAt: null,
  loginCountAtCreation: 1,
  ipHash: Buffer.from('ip'),
  userAgentHash: Buffer.from('ua'),
};

const END_USER = {
  id: 'eu_user001',
  email: 'alice@example.com',
  displayName: null,
  emailVerifiedAt: new Date(),
  metadata: {},
  createdAt: new Date(),
  lastSeenAt: new Date(),
};

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });
  void app.register(sessionCheckRoutes, { prefix: '/v1/snippet' });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/session/check', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();

    // Default: site resolves, rate limit allows, updates succeed
    mockSelectLimit.mockResolvedValue([LIVE_SITE]);
    mockUpdate.mockResolvedValue([]);
    vi.mocked(rateLimitModule.checkSessionCheckPerIp).mockResolvedValue({
      allowed: true,
      current: 1,
      limit: 120,
      resetAt: 9_999_999_999,
    });
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  // ── X-Site-Key / origin errors ─────────────────────────────────────────────

  it('returns 403 INVALID_SITE_KEY when X-Site-Key header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: { 'content-type': 'application/json', origin: 'https://site-a.example.com' },
      body: JSON.stringify({ token: VALID_RAW_TOKEN }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });

  it('returns 403 INVALID_SITE_KEY when site key not found in DB', async () => {
    mockSelectLimit.mockResolvedValueOnce([]); // site not found

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ token: VALID_RAW_TOKEN }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });

  it('returns 403 ORIGIN_NOT_ALLOWED for an unlisted origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://attacker.com',
      },
      body: JSON.stringify({ token: VALID_RAW_TOKEN }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────

  it('returns 429 RATE_LIMITED when IP limit is exceeded', async () => {
    vi.mocked(rateLimitModule.checkSessionCheckPerIp).mockResolvedValueOnce({
      allowed: false,
      current: 120,
      limit: 120,
      resetAt: Math.floor(Date.now() / 1000) + 55,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ token: VALID_RAW_TOKEN }),
    });

    expect(res.statusCode).toBe(429);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    // Must not touch the DB after the rate limit fires
    expect(mockSelectLimit).toHaveBeenCalledTimes(1); // only the site lookup
  });

  // ── Missing / invalid token → valid: false ─────────────────────────────────

  it('returns 200 { valid: false } when no body is sent (no content-type)', async () => {
    // Real snippet behavior: a POST with no token is sent with no body and no
    // content-type. Setting content-type: application/json with no body would
    // be a malformed request and Fastify correctly returns 400 for that.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        // no content-type — matching real snippet behaviour when there is no body
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  it('returns 200 { valid: false } when token field is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  it('returns 200 { valid: false } for a token with wrong prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ token: 'wh_ho_this_is_a_handoff_token_not_a_session_token' }),
    });

    // Bad format → treated as "not found", not a 400
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  it('returns 200 { valid: false } for a very short garbage token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ token: 'garbage' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  it('does NOT hit the sessions table when the token format is invalid', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ token: 'bad' }),
    });

    // Only the site lookup (1 call) — no session lookup
    expect(mockSelectLimit).toHaveBeenCalledTimes(1);
  });

  // ── Token not found in DB ──────────────────────────────────────────────────

  it('returns 200 { valid: false } when the session is not found in the DB', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([LIVE_SITE]) // site
      .mockResolvedValueOnce([]); // session not found

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ token: VALID_RAW_TOKEN }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns 200 { valid: true } with session and end_user on a valid token', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([LIVE_SITE]) // site
      .mockResolvedValueOnce([SESSION])   // session
      .mockResolvedValueOnce([END_USER]); // end_user

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ token: VALID_RAW_TOKEN }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        valid: boolean;
        session: { id: string; expires_at: string; end_user: { id: string; email: string; display_name: null } };
      };
    }>();
    expect(body.data.valid).toBe(true);
    expect(body.data.session.id).toBe(SESSION.id);
    expect(body.data.session.end_user.email).toBe(END_USER.email);
    expect(body.data.session.end_user.display_name).toBeNull();
    expect(body.data.session.expires_at).toBeTruthy();
  });

  it('calls db.update twice (sessions + end_users) on a valid token', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([LIVE_SITE])
      .mockResolvedValueOnce([SESSION])
      .mockResolvedValueOnce([END_USER]);

    await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ token: VALID_RAW_TOKEN }),
    });

    // mockUpdate is the `.where()` terminator for both updates
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('does NOT call db.update when the session is not found', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([LIVE_SITE])
      .mockResolvedValueOnce([]); // no session

    await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ token: VALID_RAW_TOKEN }),
    });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── CORS preflight ─────────────────────────────────────────────────────────

  it('responds 204 to CORS preflight OPTIONS', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/snippet/session/check',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://site-a.example.com');
  });

  // ── Response headers ───────────────────────────────────────────────────────

  it('sets X-Request-Id on all responses', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({}),
    });

    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('sets CORS Allow-Origin header on valid POST', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([LIVE_SITE])
      .mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/session/check',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ token: VALID_RAW_TOKEN }),
    });

    expect(res.headers['access-control-allow-origin']).toBe('https://site-a.example.com');
  });
});
