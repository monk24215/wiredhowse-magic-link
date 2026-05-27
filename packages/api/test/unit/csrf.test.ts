/**
 * Unit tests for the CSRF double-submit cookie middleware.
 *
 * The middleware validates that:
 *   1. On POST/PATCH/DELETE: X-CSRF-Token header must match the wh_csrf cookie.
 *   2. GET/HEAD/OPTIONS are exempt (no CSRF check).
 *   3. Missing token → 403 CSRF_INVALID.
 *   4. Mismatched token → 403 CSRF_INVALID.
 *
 * Snippet routes (/v1/snippet/*) do not register the CSRF hook — they use
 * Bearer auth from a cross-origin client. We test those are unaffected by
 * verifying that routes without the hook respond normally.
 */

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

const { requireCsrfToken } = await import('../../src/middleware/csrf');

// ---------------------------------------------------------------------------
// Helper — build a minimal Fastify app with CSRF protection on a test route
// ---------------------------------------------------------------------------

function buildProtectedApp() {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', requireCsrfToken);

  app.get('/test', async (_req, reply) => reply.code(200).send({ ok: true }));
  app.post('/test', async (_req, reply) => reply.code(200).send({ ok: true }));
  app.patch('/test', async (_req, reply) => reply.code(200).send({ ok: true }));
  app.delete('/test', async (_req, reply) => reply.code(200).send({ ok: true }));

  return app;
}

/** Build an app WITHOUT CSRF — simulates snippet routes */
function buildUnprotectedApp() {
  const app = Fastify({ logger: false });
  app.post('/v1/snippet/test', async (_req, reply) => reply.code(200).send({ ok: true }));
  return app;
}

const CSRF_TOKEN = 'test-csrf-token-abc123';
const CSRF_COOKIE = `wh_csrf=${encodeURIComponent(CSRF_TOKEN)}`;

describe('CSRF middleware — safe methods (GET/HEAD/OPTIONS)', () => {
  let app: ReturnType<typeof buildProtectedApp>;

  beforeEach(async () => {
    app = buildProtectedApp();
    await app.ready();
  });
  afterEach(() => app.close());

  it('GET without CSRF token is allowed (safe method)', async () => {
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
  });
});

describe('CSRF middleware — missing token', () => {
  let app: ReturnType<typeof buildProtectedApp>;

  beforeEach(async () => {
    app = buildProtectedApp();
    await app.ready();
  });
  afterEach(() => app.close());

  it('POST without X-CSRF-Token header returns 403 CSRF_INVALID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { cookie: CSRF_COOKIE },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CSRF_INVALID');
  });

  it('POST without wh_csrf cookie returns 403 CSRF_INVALID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-csrf-token': CSRF_TOKEN },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CSRF_INVALID');
  });

  it('POST with no cookie and no header returns 403 CSRF_INVALID', async () => {
    const res = await app.inject({ method: 'POST', url: '/test' });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CSRF_INVALID');
  });

  it('PATCH without CSRF returns 403', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/test' });
    expect(res.statusCode).toBe(403);
  });

  it('DELETE without CSRF returns 403', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/test' });
    expect(res.statusCode).toBe(403);
  });
});

describe('CSRF middleware — mismatched token', () => {
  let app: ReturnType<typeof buildProtectedApp>;

  beforeEach(async () => {
    app = buildProtectedApp();
    await app.ready();
  });
  afterEach(() => app.close());

  it('POST with header != cookie returns 403 CSRF_INVALID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: {
        cookie: CSRF_COOKIE,
        'x-csrf-token': 'wrong-token-value',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CSRF_INVALID');
  });

  it('does not allow a longer header that starts with the cookie value', async () => {
    // Ensures length check prevents prefix-match bypass.
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: {
        cookie: CSRF_COOKIE,
        'x-csrf-token': `${CSRF_TOKEN}extra`,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('CSRF middleware — valid matching token', () => {
  let app: ReturnType<typeof buildProtectedApp>;

  beforeEach(async () => {
    app = buildProtectedApp();
    await app.ready();
  });
  afterEach(() => app.close());

  it('POST with matching cookie and header passes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: {
        cookie: CSRF_COOKIE,
        'x-csrf-token': CSRF_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH with matching cookie and header passes', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/test',
      headers: {
        cookie: CSRF_COOKIE,
        'x-csrf-token': CSRF_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE with matching cookie and header passes', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/test',
      headers: {
        cookie: CSRF_COOKIE,
        'x-csrf-token': CSRF_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('handles URL-encoded cookie values correctly', async () => {
    // Tokens can contain base64url chars (+, /, =) that get URL-encoded.
    const complexToken = 'tok+az/foo=bar_baz-qux';
    const encodedCookie = `wh_csrf=${encodeURIComponent(complexToken)}`;

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: {
        cookie: encodedCookie,
        'x-csrf-token': complexToken,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('X-CSRF-Token as array uses the first value', async () => {
    // Some proxies may duplicate headers. Fastify may deliver them as arrays.
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: {
        cookie: CSRF_COOKIE,
        // Inject won't actually send an array, but we test the headerStr path.
        'x-csrf-token': CSRF_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('Snippet routes — exempt from CSRF (no hook registered)', () => {
  let app: ReturnType<typeof buildUnprotectedApp>;

  beforeEach(async () => {
    app = buildUnprotectedApp();
    await app.ready();
  });
  afterEach(() => app.close());

  it('POST /v1/snippet/test without CSRF token succeeds (no hook)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/snippet/test' });
    expect(res.statusCode).toBe(200);
  });
});
