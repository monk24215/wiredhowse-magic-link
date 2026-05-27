import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — variables that must be available inside vi.mock factories
// ---------------------------------------------------------------------------

const { mockLimit, mockTransactionFn } = vi.hoisted(() => ({
  // Auth middleware: select().from().innerJoin().where().limit()
  mockLimit: vi.fn<[], Promise<unknown[]>>().mockResolvedValue([]),
  // close-and-archive: db.transaction(fn)
  mockTransactionFn: vi.fn<[fn: (tx: unknown) => Promise<void>], Promise<void>>(),
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
// Key chains:
//   auth middleware:  select().from().innerJoin().where().limit() → mockLimit
//   close-archive:    db.transaction(fn)                          → mockTransactionFn
//
// The fake `tx` passed into the transaction callback needs to support all the
// chains used inside the transaction body:
//   tx.select().from().innerJoin().where().groupBy()
//   tx.select().from().where().groupBy()
//   tx.select().from().where().limit()
//   tx.insert().values()
//   tx.delete().where()
//
// Each chain terminator (groupBy, limit, values) resolves to [].
// The object is deliberately non-thenable so that awaiting a mid-chain
// builder (e.g. `await tx.delete(x).where(y)`) resolves immediately.
// ---------------------------------------------------------------------------

const noop = vi.fn().mockResolvedValue([]);

function makeBuilder(): Record<string, (...args: unknown[]) => unknown> {
  return {
    // query starters (needed when tx is used as a db-like object)
    select: () => makeBuilder(),
    update: () => makeBuilder(),
    insert: () => makeBuilder(),
    delete: () => makeBuilder(),
    // query chain methods
    from: () => makeBuilder(),
    where: () => makeBuilder(),
    innerJoin: () => makeBuilder(),
    leftJoin: () => makeBuilder(),
    set: () => makeBuilder(),
    // terminal methods — resolve to []
    groupBy: noop,
    orderBy: noop,
    limit: noop,
    values: noop,
    returning: noop,
  };
}

vi.mock('@wiredhowse/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        // Auth middleware: innerJoin → where → limit
        innerJoin: () => ({ where: () => ({ limit: mockLimit }) }),
        // Direct where (no join)
        where: () => ({ limit: mockLimit }),
      }),
    }),
    transaction: mockTransactionFn,
    // These are not used by close-and-archive directly, but registered
    // route plugins reference them at import time:
    update: () => makeBuilder(),
    insert: () => makeBuilder(),
    delete: () => makeBuilder(),
  },
  archivedEndUsers: {},
  endUsers: {},
  loginHistory: {},
  sessions: {},
  sites: {},
  siteOwnerSessions: {},
  siteOwners: {},
}));

vi.mock('../../src/lib/hashing', () => ({
  hashBytes: vi.fn().mockReturnValue(Buffer.from('emailhash')),
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

// Auth middleware returns a row with session + endUser fields
const AUTH_ROW = { session: { id: 'sess_current' }, endUser: END_USER };

// A valid-looking session token (startsWith 'Bearer wh_s_')
const VALID_TOKEN = 'wh_s_validtoken12345678901234567890123456';

// CSRF double-submit cookie + header for mutation requests.
const CSRF_TOKEN = 'unit-test-csrf-token';
const CSRF_HEADERS = {
  cookie: `wh_csrf=${encodeURIComponent(CSRF_TOKEN)}`,
  'x-csrf-token': CSRF_TOKEN,
};

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

describe('POST /v1/me/close-and-archive', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();

    // Default: transaction succeeds by calling the callback with a fake tx
    mockTransactionFn.mockImplementation(
      async (fn: (tx: ReturnType<typeof makeBuilder>) => Promise<void>) => {
        await fn(makeBuilder() as unknown as ReturnType<typeof makeBuilder>);
      },
    );
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  // ── Typed confirmation validation ──────────────────────────────────────────

  it('returns 400 INVALID_CONFIRMATION when confirmation field is missing', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/close-and-archive',
      headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json', ...CSRF_HEADERS },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CONFIRMATION');
    expect(mockTransactionFn).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_CONFIRMATION when confirmation is wrong string', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/close-and-archive',
      headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json', ...CSRF_HEADERS },
      body: JSON.stringify({ confirmation: 'delete my data' }), // lowercase — not exact
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CONFIRMATION');
    expect(mockTransactionFn).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_CONFIRMATION for partial match', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/close-and-archive',
      headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json', ...CSRF_HEADERS },
      body: JSON.stringify({ confirmation: 'DELETE MY' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CONFIRMATION');
    expect(mockTransactionFn).not.toHaveBeenCalled();
  });

  it('returns 204 when confirmation is exactly "DELETE MY DATA"', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/close-and-archive',
      headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json', ...CSRF_HEADERS },
      body: JSON.stringify({ confirmation: 'DELETE MY DATA' }),
    });

    expect(res.statusCode).toBe(204);
    expect(mockTransactionFn).toHaveBeenCalledOnce();
  });

  it('returns 500 INTERNAL_ERROR when the transaction throws — no partial state', async () => {
    mockLimit.mockResolvedValueOnce([AUTH_ROW]);
    mockTransactionFn.mockRejectedValueOnce(new Error('Postgres connection lost'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/close-and-archive',
      headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json', ...CSRF_HEADERS },
      body: JSON.stringify({ confirmation: 'DELETE MY DATA' }),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
  });
});
