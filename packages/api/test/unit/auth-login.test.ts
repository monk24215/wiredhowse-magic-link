import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    WH_DISABLE_RATE_LIMITS: 'true',
    SESSION_COOKIE_DOMAIN: undefined,
  },
}));

// login route call chain:
//   db.select().from().where().limit()       → look up site owner by email
//   db.update(siteOwners).set({}).where()    → reset/increment failure count
//   db.insert(siteOwnerSessions).values({}).returning({id}) → create session
const mockOwnerCurrent = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));

const mockUpdateWhere = vi.fn().mockResolvedValue([]);
const mockSessionReturning = vi.fn().mockResolvedValue([{ id: 'dsess_test123' }]);

vi.mock('@wiredhowse/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: vi.fn(() =>
            Promise.resolve(mockOwnerCurrent.value ? [mockOwnerCurrent.value] : []),
          ),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: mockSessionReturning,
      }),
    }),
    update: () => ({ set: () => ({ where: mockUpdateWhere }) }),
  },
  siteOwners: {},
  siteOwnerSessions: {},
}));

vi.mock('../../src/lib/password', () => ({
  verifyPassword: vi.fn().mockResolvedValue(true),
  dummyVerify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/rate-limit', () => ({
  checkOwnerLoginPerIp: vi
    .fn()
    .mockResolvedValue({ allowed: true, current: 1, limit: 20, resetAt: 9999999999 }),
  checkOwnerLoginPerEmail: vi
    .fn()
    .mockResolvedValue({ allowed: true, current: 1, limit: 10, resetAt: 9999999999 }),
  setRateLimitHeaders: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

const { loginRoutes } = await import('../../src/routes/auth/login');
const passwordLib = await import('../../src/lib/password');

const VERIFIED_OWNER = {
  id: 'so_test001',
  email: 'owner@example.com',
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$fakehash',
  authMethod: 'password',
  emailVerifiedAt: new Date('2024-01-01'),
  googleSub: null,
  failedLoginCount: 0,
  lockedUntil: null,
  displayName: 'Test Owner',
  createdAt: new Date('2024-01-01'),
  lastLoginAt: null,
};

function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('onSend', (req, reply, _p, done) => {
    void reply.header('X-Request-Id', req.id);
    done();
  });
  void app.register(loginRoutes);
  return app;
}

describe('POST /login', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
    mockOwnerCurrent.value = { ...VERIFIED_OWNER };
    vi.mocked(passwordLib.verifyPassword).mockResolvedValue(true);
    mockSessionReturning.mockResolvedValue([{ id: 'dsess_test123' }]);
    mockUpdateWhere.mockResolvedValue([]);
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns 200 with site_owner data and sets cookie on valid login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correctpass' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { site_owner: { id: string; email: string } } }>();
    expect(body.data.site_owner.id).toBe('so_test001');
    expect(body.data.site_owner.email).toBe('owner@example.com');
    // Cookie should be set
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toContain('wh_owner_session=');
  });

  it('cookie is HttpOnly and SameSite=Lax', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correctpass' }),
    });

    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('cookie has Max-Age=2592000 (30 days)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correctpass' }),
    });

    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).toContain('Max-Age=2592000');
  });

  // ── Error cases ─────────────────────────────────────────────────────────────

  it('returns 401 INVALID_CREDENTIALS when account not found', async () => {
    mockOwnerCurrent.value = null;

    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'irrelevant' }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');
    // Dummy verify must have been called to equalise timing
    expect(passwordLib.dummyVerify).toHaveBeenCalledOnce();
  });

  it('returns 401 INVALID_CREDENTIALS when password is wrong', async () => {
    vi.mocked(passwordLib.verifyPassword).mockResolvedValue(false);

    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'wrongpass' }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('increments failed_login_count on bad password', async () => {
    vi.mocked(passwordLib.verifyPassword).mockResolvedValue(false);
    mockOwnerCurrent.value = { ...VERIFIED_OWNER, failedLoginCount: 5 };

    await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'wrongpass' }),
    });

    expect(mockUpdateWhere).toHaveBeenCalled();
    // The set() call would have included failedLoginCount: 6
  });

  it('returns 403 EMAIL_NOT_VERIFIED when email is unverified', async () => {
    mockOwnerCurrent.value = { ...VERIFIED_OWNER, emailVerifiedAt: null };

    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correctpass' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('returns 423 ACCOUNT_LOCKED when lockedUntil is in the future', async () => {
    const lockedUntil = new Date(Date.now() + 3600 * 1000);
    mockOwnerCurrent.value = { ...VERIFIED_OWNER, lockedUntil };

    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'anypass' }),
    });

    expect(res.statusCode).toBe(423);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ACCOUNT_LOCKED');
  });

  it('allows login when lockedUntil is in the past', async () => {
    const pastLock = new Date(Date.now() - 1000);
    mockOwnerCurrent.value = { ...VERIFIED_OWNER, lockedUntil: pastLock };

    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correctpass' }),
    });

    expect(res.statusCode).toBe(200);
  });

  it('returns 403 INVALID_CREDENTIALS for Google-only account attempting password login', async () => {
    mockOwnerCurrent.value = { ...VERIFIED_OWNER, passwordHash: null, authMethod: 'google' };

    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'anypass' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 400 for missing email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'somepass' }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com' }),
    });

    expect(res.statusCode).toBe(400);
  });
});
