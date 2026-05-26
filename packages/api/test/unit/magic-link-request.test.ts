import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (registered before any imports that touch these modules)
// ---------------------------------------------------------------------------

vi.mock('../../src/config', () => ({
  config: {
    NODE_ENV: 'test',
    WH_DISABLE_RATE_LIMITS: 'true', // disable Redis for unit tests
    SITE_URL: 'https://magic-link.wiredhowse.app',
    RESEND_API_KEY: 'test',
    RESEND_FROM: 'no-reply@magic-link.wiredhowse.app',
    EMAIL_FROM_NAME: 'wiredHowse Auth',
    EMAIL_REPLY_TO: 'support@wiredhowse.app',
  },
}));

const mockDbInsert = vi.fn().mockResolvedValue([]);
const mockDbSelect = vi.fn();

vi.mock('@wiredhowse/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockDbSelect }) }) }),
    insert: () => ({ values: mockDbInsert }),
  },
  sites: {},
  magicLinks: {},
}));

vi.mock('../../src/services/email', () => ({
  sendMagicLinkEmail: vi.fn().mockResolvedValue({ id: 'email_123' }),
}));

vi.mock('../../src/services/rate-limit', () => ({
  checkMagicLinkPerIp: vi.fn().mockResolvedValue({ allowed: true, current: 1, limit: 10, resetAt: 9999999999 }),
  checkMagicLinkPerSite: vi.fn().mockResolvedValue({ allowed: true, current: 1, limit: 50, resetAt: 9999999999 }),
  checkMagicLinkPerEmail: vi.fn().mockResolvedValue({ allowed: true, current: 1, limit: 3, resetAt: 9999999999 }),
  setRateLimitHeaders: vi.fn(),
}));

// Drizzle operators are just pass-through in tests
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

const { magicLinkRequestRoutes } = await import('../../src/routes/snippet/magic-link-request');
const { sendMagicLinkEmail } = await import('../../src/services/email');
const rateLimitModule = await import('../../src/services/rate-limit');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LIVE_SITE = {
  id: 'st_testsite001',
  siteKey: 'pk_testkey123456789012345',
  domain: 'example.com',
  state: 'live',
  allowedOrigins: ['https://example.com'],
};

function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });
  void app.register(magicLinkRequestRoutes, { prefix: '/v1/snippet' });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/magic-link/request', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
    mockDbSelect.mockResolvedValue([LIVE_SITE]);
    vi.mocked(rateLimitModule.checkMagicLinkPerIp).mockResolvedValue({ allowed: true, current: 1, limit: 10, resetAt: 9999999999 });
    vi.mocked(rateLimitModule.checkMagicLinkPerSite).mockResolvedValue({ allowed: true, current: 1, limit: 50, resetAt: 9999999999 });
    vi.mocked(rateLimitModule.checkMagicLinkPerEmail).mockResolvedValue({ allowed: true, current: 1, limit: 3, resetAt: 9999999999 });
    vi.mocked(sendMagicLinkEmail).mockResolvedValue({ id: 'email_123' });
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns 200 { sent: true } on valid request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { sent: boolean; expires_in_seconds: number } }>();
    expect(body.data.sent).toBe(true);
    expect(body.data.expires_in_seconds).toBe(900);
  });

  it('inserts a magic_links row and fires email on success', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(mockDbInsert).toHaveBeenCalledOnce();
    // Give the fire-and-forget a tick to resolve
    await new Promise((r) => setTimeout(r, 0));
    expect(sendMagicLinkEmail).toHaveBeenCalledOnce();
    const emailArgs = vi.mocked(sendMagicLinkEmail).mock.calls[0]?.[0];
    expect(emailArgs?.to).toBe('alice@example.com');
    expect(emailArgs?.siteDomain).toBe('example.com');
    expect(emailArgs?.magicLinkUrl).toMatch(/^https:\/\/magic-link\.wiredhowse\.app\/v1\/magic\/redeem\?token=wh_ml_/);
  });

  it('sets X-Request-Id response header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.headers['x-request-id']).toBeTruthy();
  });

  // ── Site key / origin errors ───────────────────────────────────────────────

  it('returns 403 INVALID_SITE_KEY when header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });

  it('returns 403 INVALID_SITE_KEY when site key not found in DB', async () => {
    mockDbSelect.mockResolvedValue([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });

  it('returns 403 ORIGIN_NOT_ALLOWED for unlisted origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://attacker.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  // ── Site state ─────────────────────────────────────────────────────────────

  it('returns 403 SITE_DISABLED when site state is not live', async () => {
    mockDbSelect.mockResolvedValue([{ ...LIVE_SITE, state: 'disabled' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SITE_DISABLED');
  });

  it('returns 403 SITE_DISABLED when site state is pending_verification', async () => {
    mockDbSelect.mockResolvedValue([{ ...LIVE_SITE, state: 'pending_verification' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('SITE_DISABLED');
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  it('returns 400 for malformed email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing email field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────

  it('returns 429 when IP rate limit is exceeded', async () => {
    vi.mocked(rateLimitModule.checkMagicLinkPerIp).mockResolvedValue({
      allowed: false,
      current: 10,
      limit: 10,
      resetAt: Math.floor(Date.now() / 1000) + 800,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.statusCode).toBe(429);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('returns 429 when site rate limit is exceeded', async () => {
    vi.mocked(rateLimitModule.checkMagicLinkPerSite).mockResolvedValue({
      allowed: false,
      current: 50,
      limit: 50,
      resetAt: Math.floor(Date.now() / 1000) + 3000,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    expect(res.statusCode).toBe(429);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('returns 200 silently when email rate limit is exceeded (prevents enumeration)', async () => {
    vi.mocked(rateLimitModule.checkMagicLinkPerEmail).mockResolvedValue({
      allowed: false,
      current: 3,
      limit: 3,
      resetAt: Math.floor(Date.now() / 1000) + 800,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    // Must still return 200 — not 429 — to prevent email enumeration
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { sent: boolean } }>().data.sent).toBe(true);
    // Must NOT insert a row or send email
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('does not increment email counter when IP limit fires', async () => {
    vi.mocked(rateLimitModule.checkMagicLinkPerIp).mockResolvedValue({
      allowed: false,
      current: 10,
      limit: 10,
      resetAt: Math.floor(Date.now() / 1000) + 800,
    });

    await app.inject({
      method: 'POST',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'content-type': 'application/json',
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });

    // Email check must not be called when IP fires first
    expect(rateLimitModule.checkMagicLinkPerEmail).not.toHaveBeenCalled();
  });

  // ── OPTIONS preflight ──────────────────────────────────────────────────────

  it('responds 204 to CORS preflight OPTIONS', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/snippet/magic-link/request',
      headers: {
        'x-site-key': LIVE_SITE.siteKey,
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
  });
});
