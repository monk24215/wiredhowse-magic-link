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

// signup route call chain:
//   db.select().from().where().limit()                           → existing email check
//   db.insert(siteOwners).values({}).returning({id})            → create owner
//   db.insert(emailVerifications).values({})                    → create verification (no .returning)
const mockSelectLimit = vi.fn();
const mockInsertReturning = vi.fn().mockResolvedValue([{ id: 'so_test123' }]);

vi.mock('@wiredhowse/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) }),
    insert: () => ({
      values: () => ({
        // .returning() used by site_owner insert
        returning: mockInsertReturning,
        // .values() awaited directly by emailVerifications insert — ok, resolves to this object
      }),
    }),
  },
  siteOwners: {},
  emailVerifications: {},
}));

vi.mock('../../src/services/email', () => ({
  sendEmailVerificationEmail: vi.fn().mockResolvedValue({ id: 'email_test' }),
}));

vi.mock('../../src/services/rate-limit', () => ({
  checkGenericPerIp: vi
    .fn()
    .mockResolvedValue({ allowed: true, current: 1, limit: 30, resetAt: 9999999999 }),
  setRateLimitHeaders: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

const { signupRoutes } = await import('../../src/routes/auth/signup');
const { sendEmailVerificationEmail } = await import('../../src/services/email');

function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('onSend', (req, reply, _p, done) => {
    void reply.header('X-Request-Id', req.id);
    done();
  });
  void app.register(signupRoutes);
  return app;
}

describe('POST /signup', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
    // Default: email not already taken
    mockSelectLimit.mockResolvedValue([]);
    mockInsertReturning.mockResolvedValue([{ id: 'so_test123' }]);
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns 201 with a success message on valid signup', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'securepass123' }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { message: string } }>();
    expect(body.data.message).toContain('Check your email');
  });

  it('sends a verification email after successful signup', async () => {
    await app.inject({
      method: 'POST',
      url: '/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'securepass123' }),
    });

    // Give the fire-and-forget a tick to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(sendEmailVerificationEmail).toHaveBeenCalledOnce();
    const call = vi.mocked(sendEmailVerificationEmail).mock.calls[0]?.[0];
    expect(call?.to).toBe('alice@example.com');
    expect(call?.verifyUrl).toContain('wh_ev_');
  });

  it('returns 409 EMAIL_ALREADY_REGISTERED when email is taken', async () => {
    mockSelectLimit.mockResolvedValue([{ id: 'so_existing' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'taken@example.com', password: 'securepass123' }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('EMAIL_ALREADY_REGISTERED');
    // Must not attempt to insert
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'securepass123' }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a password shorter than 8 chars', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'short' }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when body is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
  });
});
