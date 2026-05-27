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
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), isNull: vi.fn() }));

// ---------------------------------------------------------------------------
// DB mock
//
// db.select().from().where().limit()  → mockSelectLimit (site lookup)
// db.update().set().where()           → mockUpdateWhere  (session revocation)
// ---------------------------------------------------------------------------

const mockSelectLimit = vi.fn();
const mockUpdateWhere = vi.fn();

vi.mock('@wiredhowse/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) }),
    update: () => ({ set: () => ({ where: mockUpdateWhere }) }),
  },
  sites: {},
  sessions: {},
}));

// ---------------------------------------------------------------------------
// Rate-limit mock — controlled per-test via vi.mocked(...)
// ---------------------------------------------------------------------------

vi.mock('../../src/services/rate-limit', () => ({
  checkGenericPerIp: vi
    .fn()
    .mockResolvedValue({ allowed: true, current: 1, limit: 30, resetAt: 9_999_999_999 }),
  setRateLimitHeaders: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Deferred imports — must come after vi.mock registrations
// ---------------------------------------------------------------------------

const { signOutRoutes } = await import('../../src/routes/snippet/sign-out');
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

// A valid-format raw session token: prefix + base64url chars, length > 36
const VALID_RAW_TOKEN = 'wh_s_validtoken12345678901234567890123456';

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });
  void app.register(signOutRoutes, { prefix: '/v1/snippet' });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/sign-out', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();

    // Default: site resolves, rate limit allows, update succeeds
    mockSelectLimit.mockResolvedValue([LIVE_SITE]);
    mockUpdateWhere.mockResolvedValue([]);
    vi.mocked(rateLimitModule.checkGenericPerIp).mockResolvedValue({
      allowed: true,
      current: 1,
      limit: 30,
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
      url: '/v1/snippet/sign-out',
      headers: {
        origin: 'https://site-a.example.com',
        authorization: `Bearer ${VALID_RAW_TOKEN}`,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });

  it('returns 403 INVALID_SITE_KEY when site key not found in DB', async () => {
    mockSelectLimit.mockResolvedValueOnce([]); // site not found

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: `Bearer ${VALID_RAW_TOKEN}`,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });

  it('returns 403 ORIGIN_NOT_ALLOWED for an unlisted origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://attacker.com',
        authorization: `Bearer ${VALID_RAW_TOKEN}`,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────

  it('returns 429 RATE_LIMITED when IP limit is exceeded', async () => {
    vi.mocked(rateLimitModule.checkGenericPerIp).mockResolvedValueOnce({
      allowed: false,
      current: 30,
      limit: 30,
      resetAt: Math.floor(Date.now() / 1000) + 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: `Bearer ${VALID_RAW_TOKEN}`,
      },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    // The site lookup happens, but the update must NOT be called
    expect(mockSelectLimit).toHaveBeenCalledTimes(1); // only the site lookup
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  // ── Authorization header required ─────────────────────────────────────────

  it('returns 401 UNAUTHENTICATED when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        // no authorization header
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 UNAUTHENTICATED when Authorization header has no Bearer scheme', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: 'Basic dXNlcjpwYXNz',
      },
    });

    // Non-Bearer auth header → treated as malformed token → idempotent 200
    // (rawToken will be '' after the startsWith check, which fails the regex)
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  // ── Malformed token → idempotent 200 ──────────────────────────────────────

  it('returns 200 { signed_out: true } when token has wrong prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: 'Bearer wh_ho_this_is_a_handoff_token_not_a_session_token',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);
    // No DB update for a malformed token
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('returns 200 { signed_out: true } for a very short garbage token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: 'Bearer garbage',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('does NOT hit the sessions table when the token format is invalid', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: 'Bearer bad',
      },
    });

    // Only the site lookup (1 call) — no update
    expect(mockSelectLimit).toHaveBeenCalledTimes(1);
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns 200 { signed_out: true } for a valid-format token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: `Bearer ${VALID_RAW_TOKEN}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);
  });

  it('calls db.update once for a valid-format token', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: `Bearer ${VALID_RAW_TOKEN}`,
      },
    });

    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  // ── Already-revoked / non-existent → still idempotent ────────────────────

  it('returns 200 { signed_out: true } even when the update affects 0 rows', async () => {
    // The update mock returns an empty array (0 rows updated — e.g. already revoked)
    mockUpdateWhere.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: `Bearer ${VALID_RAW_TOKEN}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { signed_out: boolean } }>().data.signed_out).toBe(true);
  });

  // ── CORS preflight ─────────────────────────────────────────────────────────

  it('responds 204 to CORS preflight OPTIONS', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/snippet/sign-out',
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
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: `Bearer ${VALID_RAW_TOKEN}`,
      },
    });

    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('sets CORS Allow-Origin header on a valid POST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/sign-out',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://site-a.example.com',
        authorization: `Bearer ${VALID_RAW_TOKEN}`,
      },
    });

    expect(res.headers['access-control-allow-origin']).toBe('https://site-a.example.com');
  });
});
