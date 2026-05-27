/**
 * Integration tests for Site Owner auth flows (deferred from chunk 7a).
 *
 * Uses a real Postgres testcontainer + Drizzle migrations.
 * Redis is not used — rate limits are disabled via WH_DISABLE_RATE_LIMITS.
 * Email sending is mocked — we capture the emitted URL to simulate clicking links.
 *
 * Covered flows:
 *   A. Signup → verify-email → login → logout
 *   B. Password reset end-to-end (request → reset → login)
 *   C. Google OAuth callback (new account, email link, state replay)
 *   D. Account lockout after 10 failures + lockout expiry
 *   E. Dummy-verify timing protection (dummyVerify is called on unknown email)
 *   F. Email-verification token single-use enforcement
 *   G. Password-reset token single-use enforcement
 */

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://placeholder:placeholder@localhost:5432/placeholder';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.RESEND_API_KEY = 'test';
});

// ---------------------------------------------------------------------------
// Module mocks (must come before deferred imports)
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
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
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

// Capture email tokens instead of actually sending them.
const capturedVerifyUrls: string[] = [];
const capturedResetUrls: string[] = [];

vi.mock('../../src/services/email', () => ({
  sendEmailVerificationEmail: vi.fn(({ verifyUrl }: { verifyUrl: string }) => {
    capturedVerifyUrls.push(verifyUrl);
    return Promise.resolve({ id: 'mock-email-id' });
  }),
  sendPasswordResetEmail: vi.fn(({ resetUrl }: { resetUrl: string }) => {
    capturedResetUrls.push(resetUrl);
    return Promise.resolve({ id: 'mock-email-id' });
  }),
  sendMagicLinkEmail: vi.fn().mockResolvedValue({ id: 'mock-email-id' }),
}));

// ---------------------------------------------------------------------------
// Deferred imports
// ---------------------------------------------------------------------------

import Fastify, { type FastifyInstance } from 'fastify';
import {
  emailVerifications,
  oauthState,
  passwordResets,
  siteOwnerSessions,
  siteOwners,
  sites,
} from '@wiredhowse/db';
import { eq, isNull } from 'drizzle-orm';
import { runMigrations } from '../../../db/src/migrate';
import { registerGlobalErrorHandler } from '../../src/errors';
import { hashToken } from '../../src/lib/crypto';
import { addHours, addMinutes, nowUtc } from '../../src/lib/time';
import { authRoutes } from '../../src/routes/auth/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testDb() {
  if (!dbHolder.current) throw new Error('Test DB not initialised');
  return dbHolder.current;
}

/** Extract the token query param from a captured email URL. */
function extractToken(url: string): string {
  const u = new URL(url);
  const token = u.searchParams.get('token');
  if (!token) throw new Error(`No ?token= in URL: ${url}`);
  return token;
}

/** Build a matching CSRF header + cookie pair (simulates a logged-in browser). */
function csrfHeaders(token = 'integration-csrf-token') {
  return {
    cookie: `wh_csrf=${encodeURIComponent(token)}`,
    'x-csrf-token': token,
  };
}

/**
 * Parse the session + CSRF cookies from a Set-Cookie response header.
 * Returns the raw session token (to make subsequent requests) and the
 * CSRF token value.
 */
function parseSetCookies(setCookie: string | string[] | undefined): {
  sessionCookieHeader: string;
  csrfToken: string | null;
} {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === 'string'
      ? [setCookie]
      : [];

  const sessionCookieFull = cookies.find((c) => c.startsWith('wh_owner_session=')) ?? '';
  const csrfCookieFull = cookies.find((c) => c.startsWith('wh_csrf=')) ?? '';

  // Extract just `name=value` for use as the Cookie request header.
  const sessionKV = sessionCookieFull.split(';')[0] ?? '';
  const csrfKV = csrfCookieFull.split(';')[0] ?? '';
  const csrfValue = csrfKV ? decodeURIComponent(csrfKV.slice('wh_csrf='.length)) : null;

  return { sessionCookieHeader: sessionKV, csrfToken: csrfValue };
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
  void app.register(authRoutes, { prefix: '/v1/auth' });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await pgClient.end();
  await container.stop();
});

afterEach(async () => {
  const db = testDb();
  capturedVerifyUrls.length = 0;
  capturedResetUrls.length = 0;
  await db.delete(siteOwnerSessions);
  await db.delete(passwordResets);
  await db.delete(emailVerifications);
  await db.delete(sites);
  await db.delete(siteOwners);
  await db.delete(oauthState);
});

// ---------------------------------------------------------------------------
// A. Full signup → verify-email → login → logout
// ---------------------------------------------------------------------------

describe('Flow A: Signup → verify-email → login → logout', () => {
  const email = 'flowA@test.example';
  const password = 'S3cur3Pass!23';

  it('signup returns 201 and sends an email verification link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    expect(res.statusCode).toBe(201);
    expect(capturedVerifyUrls).toHaveLength(1);
    expect(capturedVerifyUrls[0]).toContain('https://magic-link.wiredhowse.app/verify?token=wh_ev_');
  });

  it('login before verification returns 403 EMAIL_NOT_VERIFIED', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('verify-email marks email_verified_at in DB', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const token = extractToken(capturedVerifyUrls[0]!);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { verified: boolean } }>().data.verified).toBe(true);

    // Check DB
    const db = testDb();
    const [owner] = await db
      .select({ emailVerifiedAt: siteOwners.emailVerifiedAt })
      .from(siteOwners)
      .where(eq(siteOwners.email, email))
      .limit(1);
    expect(owner?.emailVerifiedAt).not.toBeNull();
  });

  it('login after verification returns 200 with session + CSRF cookies', async () => {
    // Signup
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    // Verify
    const verifyToken = extractToken(capturedVerifyUrls[0]!);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: verifyToken }),
    });

    // Login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    expect(loginRes.statusCode).toBe(200);

    const setCookie = loginRes.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    const sessionCookie = cookies.find((c) => c.startsWith('wh_owner_session='));
    const csrfCookie = cookies.find((c) => c.startsWith('wh_csrf='));

    expect(sessionCookie).toMatch(/HttpOnly/);
    expect(sessionCookie).toMatch(/SameSite=Lax/);
    expect(csrfCookie).toBeDefined();
    // CSRF cookie must NOT be HttpOnly
    expect(csrfCookie).not.toMatch(/HttpOnly/);
  });

  it('logout revokes the session and clears cookies', async () => {
    // Full signup → verify → login
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const verifyToken = extractToken(capturedVerifyUrls[0]!);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: verifyToken }),
    });
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const { sessionCookieHeader, csrfToken } = parseSetCookies(loginRes.headers['set-cookie']);
    expect(csrfToken).not.toBeNull();

    // Logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        cookie: `${sessionCookieHeader}; wh_csrf=${encodeURIComponent(csrfToken!)}`,
        'x-csrf-token': csrfToken!,
      },
    });

    expect(logoutRes.statusCode).toBe(200);

    // Session must be revoked in DB
    const db = testDb();
    const [sess] = await db
      .select({ revokedAt: siteOwnerSessions.revokedAt })
      .from(siteOwnerSessions)
      .limit(1);
    expect(sess?.revokedAt).not.toBeNull();

    // Set-Cookie must clear both cookies (Max-Age=0)
    const clearCookies = logoutRes.headers['set-cookie'];
    const clearArr = Array.isArray(clearCookies) ? clearCookies : [String(clearCookies)];
    expect(clearArr.some((c) => c.startsWith('wh_owner_session=') && c.includes('Max-Age=0'))).toBe(true);
    expect(clearArr.some((c) => c.startsWith('wh_csrf=') && c.includes('Max-Age=0'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. Password reset end-to-end
// ---------------------------------------------------------------------------

describe('Flow B: Password reset', () => {
  const email = 'pwreset@test.example';
  const initialPassword = 'OldP@ss1!';
  const newPassword = 'NewP@ss2!';

  async function setupVerifiedAccount() {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: initialPassword }),
    });
    const verifyToken = extractToken(capturedVerifyUrls[0]!);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: verifyToken }),
    });
    capturedVerifyUrls.length = 0;
  }

  it('request-password-reset always returns 200 (prevents enumeration)', async () => {
    // Without an account
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@test.example' }),
    });
    expect(res1.statusCode).toBe(200);

    // With a real account
    await setupVerifiedAccount();
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    expect(res2.statusCode).toBe(200);
    // A reset email was actually sent
    expect(capturedResetUrls).toHaveLength(1);
  });

  it('reset-password with valid token updates the password', async () => {
    await setupVerifiedAccount();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    const resetToken = extractToken(capturedResetUrls[0]!);

    const resetRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: resetToken, new_password: newPassword }),
    });
    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.json<{ data: { reset: boolean } }>().data.reset).toBe(true);
  });

  it('login with old password fails after reset; new password works', async () => {
    await setupVerifiedAccount();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const resetToken = extractToken(capturedResetUrls[0]!);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: resetToken, new_password: newPassword }),
    });

    // Old password should fail
    const oldRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: initialPassword }),
    });
    expect(oldRes.statusCode).toBe(401);

    // New password should succeed
    const newRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: newPassword }),
    });
    expect(newRes.statusCode).toBe(200);
  });

  it('reset-password revokes all existing sessions', async () => {
    const db = testDb();
    await setupVerifiedAccount();

    // Get a session first
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: initialPassword }),
    });
    expect(loginRes.statusCode).toBe(200);

    // Confirm session is active
    const activeBefore = await db
      .select()
      .from(siteOwnerSessions)
      .where(isNull(siteOwnerSessions.revokedAt));
    expect(activeBefore).toHaveLength(1);

    // Reset password
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const resetToken = extractToken(capturedResetUrls[0]!);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: resetToken, new_password: newPassword }),
    });

    // All sessions should now be revoked
    const activeAfter = await db
      .select()
      .from(siteOwnerSessions)
      .where(isNull(siteOwnerSessions.revokedAt));
    expect(activeAfter).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C. Google OAuth callback
// ---------------------------------------------------------------------------

describe('Flow C: Google OAuth callback', () => {
  const GOOGLE_SUB = 'google-sub-123456';
  const GOOGLE_EMAIL = 'googleuser@gmail.com';

  /** Insert an oauth_state row and return the state token. */
  async function insertOAuthState(returnTo = '/dashboard') {
    const db = testDb();
    const state = `wh_os_teststate${Date.now()}`;
    await db.insert(oauthState).values({
      state,
      expiresAt: addMinutes(nowUtc(), 10),
      returnTo,
    });
    return state;
  }

  /** Mock the global fetch used by the OAuth callback to call Google APIs. */
  function mockGoogleFetch(overrides?: {
    tokenOk?: boolean;
    userInfo?: Partial<{ sub: string; email: string; email_verified: boolean; name: string }>;
  }) {
    const tokenOk = overrides?.tokenOk ?? true;
    const userInfo = {
      sub: GOOGLE_SUB,
      email: GOOGLE_EMAIL,
      email_verified: true,
      name: 'Google User',
      ...overrides?.userInfo,
    };

    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

      if (url.includes('oauth2.googleapis.com/token')) {
        if (!tokenOk) {
          return new Response('{"error":"invalid_grant"}', { status: 400 });
        }
        return new Response(
          JSON.stringify({ access_token: 'mock-access-token', token_type: 'Bearer', scope: 'openid email profile' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return new Response(JSON.stringify(userInfo), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      // Fall through for anything else
      return new Response('not mocked', { status: 500 });
    });

    return spy;
  }

  it('creates a new Site Owner on first Google OAuth login', async () => {
    const db = testDb();
    const state = await insertOAuthState();
    const fetchSpy = mockGoogleFetch();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=testcode&state=${state}`,
    });

    fetchSpy.mockRestore();

    // Should redirect to dashboard
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/\/dashboard/);

    // Session + CSRF cookies should be set
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    expect(cookies.some((c) => c.startsWith('wh_owner_session='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('wh_csrf='))).toBe(true);

    // A new Site Owner should exist in DB
    const [owner] = await db
      .select()
      .from(siteOwners)
      .where(eq(siteOwners.email, GOOGLE_EMAIL))
      .limit(1);
    expect(owner).toBeDefined();
    expect(owner?.googleSub).toBe(GOOGLE_SUB);
    expect(owner?.authMethod).toBe('google');
    expect(owner?.emailVerifiedAt).not.toBeNull(); // Google email is pre-verified
  });

  it('links Google sub to existing password account with the same email', async () => {
    const db = testDb();

    // Create a password-only account first
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: GOOGLE_EMAIL, password: 'SomeP@ss1' }),
    });
    // Verify the email
    const verifyToken = extractToken(capturedVerifyUrls[0]!);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: verifyToken }),
    });

    // Now OAuth login with the same email
    const state = await insertOAuthState();
    const fetchSpy = mockGoogleFetch();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=testcode&state=${state}`,
    });
    fetchSpy.mockRestore();

    expect(res.statusCode).toBe(302);

    // auth_method should now be 'both'; google_sub should be set
    const [owner] = await db
      .select()
      .from(siteOwners)
      .where(eq(siteOwners.email, GOOGLE_EMAIL))
      .limit(1);
    expect(owner?.googleSub).toBe(GOOGLE_SUB);
    expect(owner?.authMethod).toBe('both');

    // Only one record for this email
    const all = await db.select().from(siteOwners).where(eq(siteOwners.email, GOOGLE_EMAIL));
    expect(all).toHaveLength(1);
  });

  it('rejects callback with invalid or expired state — redirects to /login?error=oauth_invalid', async () => {
    const fetchSpy = mockGoogleFetch();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/callback?code=testcode&state=wh_os_nonexistent',
    });
    fetchSpy.mockRestore();

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=oauth_invalid');
  });

  it('rejects replay of a consumed state', async () => {
    const db = testDb();
    const state = await insertOAuthState();

    // First callback — succeeds
    const fetchSpy = mockGoogleFetch();
    await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=testcode&state=${state}`,
    });
    fetchSpy.mockRestore();

    // Verify state row is consumed
    const [stateRow] = await db
      .select()
      .from(oauthState)
      .where(eq(oauthState.state, state))
      .limit(1);
    expect(stateRow?.consumedAt).not.toBeNull();

    // Second callback with same state — must be rejected
    const fetchSpy2 = mockGoogleFetch();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=testcode&state=${state}`,
    });
    fetchSpy2.mockRestore();

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=oauth_invalid');
  });

  it('redirects to login?error=oauth_failed when Google token exchange fails', async () => {
    const state = await insertOAuthState();
    const fetchSpy = mockGoogleFetch({ tokenOk: false });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=badcode&state=${state}`,
    });
    fetchSpy.mockRestore();

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=oauth_failed');
  });
});

// ---------------------------------------------------------------------------
// D. Account lockout after 10 failed login attempts
// ---------------------------------------------------------------------------

describe('Flow D: Account lockout', () => {
  const email = 'lockout@test.example';
  const correctPassword = 'C0rrect!Pw1';

  async function setupVerifiedAccount() {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: correctPassword }),
    });
    const verifyToken = extractToken(capturedVerifyUrls[0]!);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: verifyToken }),
    });
    capturedVerifyUrls.length = 0;
  }

  it('locks the account after 10 failed login attempts and returns 423 ACCOUNT_LOCKED', async () => {
    await setupVerifiedAccount();

    // Make 9 failed attempts — should all return 401
    for (let i = 0; i < 9; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrongpassword' }),
      });
      expect(res.statusCode).toBe(401);
    }

    // 10th failure — should trigger lockout, returning 423
    const lockRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrongpassword' }),
    });
    expect(lockRes.statusCode).toBe(423);
    expect(lockRes.json<{ error: { code: string } }>().error.code).toBe('ACCOUNT_LOCKED');
  });

  it('rejects correct password when account is locked', async () => {
    await setupVerifiedAccount();

    // 10 failures to trigger lockout
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrongpassword' }),
      });
    }

    // Even the correct password should fail while locked
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: correctPassword }),
    });
    expect(res.statusCode).toBe(423);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ACCOUNT_LOCKED');
  });

  it('allows login after locked_until expires', async () => {
    const db = testDb();
    await setupVerifiedAccount();

    // Force-set locked_until to the past to simulate expiry
    await db
      .update(siteOwners)
      .set({
        failedLoginCount: 10,
        lockedUntil: new Date(Date.now() - 1000), // 1 second ago
      })
      .where(eq(siteOwners.email, email));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: correctPassword }),
    });

    expect(res.statusCode).toBe(200);
  });

  it('failed_login_count is reset to 0 after successful login', async () => {
    const db = testDb();
    await setupVerifiedAccount();

    // Set some failures without locking
    await db
      .update(siteOwners)
      .set({ failedLoginCount: 5, lockedUntil: null })
      .where(eq(siteOwners.email, email));

    await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: correctPassword }),
    });

    const [owner] = await db
      .select({ failedLoginCount: siteOwners.failedLoginCount })
      .from(siteOwners)
      .where(eq(siteOwners.email, email))
      .limit(1);
    expect(owner?.failedLoginCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E. Dummy-verify timing protection
// ---------------------------------------------------------------------------

describe('Flow E: Dummy-verify timing protection', () => {
  it('dummyVerify is called when email is not found — prevents timing enumeration', async () => {
    // Import the password module to spy on dummyVerify.
    const passwordModule = await import('../../src/lib/password');
    const spy = vi.spyOn(passwordModule, 'dummyVerify');

    await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@test.example', password: 'irrelevant' }),
    });

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('dummyVerify is NOT called when email is found (real verify runs)', async () => {
    // Signup a real account (unverified — does not matter for timing test)
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'timing@test.example', password: 'S3cur3P@ss' }),
    });

    const passwordModule = await import('../../src/lib/password');
    const spy = vi.spyOn(passwordModule, 'dummyVerify');

    await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'timing@test.example', password: 'wrongpass' }),
    });

    // dummyVerify should NOT have been called — we ran the real verifyPassword
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// F. Email verification token single-use enforcement
// ---------------------------------------------------------------------------

describe('Flow F: Email verification token single-use', () => {
  const email = 'singleuse-ev@test.example';

  it('second use of the same verify token returns 404 INVALID_TOKEN', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Sec!Pass1' }),
    });

    const token = extractToken(capturedVerifyUrls[0]!);

    // First use — should succeed
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(first.statusCode).toBe(200);

    // Second use — same token must be rejected
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(second.statusCode).toBe(404);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('INVALID_TOKEN');
  });

  it('expired verify token is rejected', async () => {
    const db = testDb();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'expired-ev@test.example', password: 'Sec!Pass1' }),
    });

    const token = extractToken(capturedVerifyUrls[0]!);

    // Force-expire the token
    await db
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.tokenHash, hashToken(token)));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// G. Password reset token single-use enforcement
// ---------------------------------------------------------------------------

describe('Flow G: Password reset token single-use', () => {
  const email = 'singleuse-pr@test.example';
  const password = 'Init!Pass1';

  async function setupAndRequestReset() {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const verifyToken = extractToken(capturedVerifyUrls[0]!);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: verifyToken }),
    });
    capturedVerifyUrls.length = 0;

    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    return extractToken(capturedResetUrls[0]!);
  }

  it('second use of the same reset token returns 404 INVALID_TOKEN', async () => {
    const token = await setupAndRequestReset();

    // First use — should succeed
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, new_password: 'NewPass1!' }),
    });
    expect(first.statusCode).toBe(200);

    // Second use — same token must be rejected
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, new_password: 'AnotherPass1!' }),
    });
    expect(second.statusCode).toBe(404);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('INVALID_TOKEN');
  });

  it('expired reset token is rejected', async () => {
    const db = testDb();
    const token = await setupAndRequestReset();

    // Force-expire the reset token
    await db
      .update(passwordResets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResets.tokenHash, hashToken(token)));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, new_password: 'NewPass1!' }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// Bonus: signup duplicate email returns 409
// ---------------------------------------------------------------------------

describe('Signup edge cases', () => {
  it('second signup with same email returns 409 EMAIL_ALREADY_REGISTERED', async () => {
    const email = 'dup@test.example';
    await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Pass1!xyz' }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Pass1!xyz' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });
});
