import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (registered before any imports that touch these modules)
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

// Drizzle operators are pass-through in unit tests
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

// ---------------------------------------------------------------------------
// DB mock — separate mock selects for resolveSite vs the transaction selects
// ---------------------------------------------------------------------------

const mockSiteSelect = vi.fn();
const mockDbTransaction = vi.fn();

vi.mock('@wiredhowse/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockSiteSelect }) }) }),
    transaction: (cb: (tx: unknown) => unknown) => mockDbTransaction(cb),
  },
  sites: {},
  handoffTokens: {},
  sessions: {},
  endUsers: {},
}));

// ---------------------------------------------------------------------------
// Deferred imports — must come after vi.mock registrations
// ---------------------------------------------------------------------------

const { handoffExchangeRoutes } = await import('../../src/routes/snippet/handoff-exchange');

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SITE_A = {
  id: 'st_siteAAAAAAAAA',
  // siteKeyHeaderSchema requires >= 22 chars after "pk_"
  siteKey: 'pk_siteAkey12345678901234',
  domain: 'site-a.example.com',
  state: 'live',
  allowedOrigins: ['https://site-a.example.com'],
};

const SITE_B_ID = 'st_siteBBBBBBBBB';

const VALID_HANDOFF_TOKEN = {
  id: 'ho_validhandoff01',
  sessionId: 'sess_abc123',
  tokenHash: Buffer.from('mockhash'),
  rawSessionToken: 'wh_s_mocksessiontoken12345678901234567890123',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000), // 60 s in future
  redeemedAt: null,
};

const SESSION_SITE_A = {
  id: 'sess_abc123',
  siteId: SITE_A.id, // matches requester
  endUserId: 'eu_user001',
  tokenHash: Buffer.from('sessionhash'),
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 7_200_000),
  lastUsedAt: new Date(),
  revokedAt: null,
  loginCountAtCreation: 0,
  ipHash: Buffer.from('ip'),
  userAgentHash: Buffer.from('ua'),
};

const SESSION_SITE_B = {
  ...SESSION_SITE_A,
  siteId: SITE_B_ID, // DIFFERENT from SITE_A.id — triggers mismatch
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
// Helper: build a tx mock that returns results in call order.
//
// Each `tx.select().from().where().limit()` call consumes the next entry from
// `selectResults`. `.for('update')` on the first select is handled by making
// the return value both directly awaitable AND have a `.for()` method.
// ---------------------------------------------------------------------------

// Build a real Promise with an attached `.for()` method so both:
//   await tx.select()...limit(1)            -- resolves to data
//   await tx.select()...limit(1).for('update') -- resolves to data
//
// Using Object.assign on a real Promise avoids Biome's noThenProperty rule,
// which bans { then: ... } on plain objects (they unintentionally become
// thenable and can confuse async code in ways that are hard to debug).
function makeAwaitable<T>(data: T[]): Promise<T[]> & { for: (_mode: string) => Promise<T[]> } {
  return Object.assign(Promise.resolve(data), {
    for: (_mode: string) => Promise.resolve(data),
  });
}

function makeTxMock(selectResults: unknown[][]) {
  let callIndex = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => makeAwaitable(selectResults[callIndex++] ?? []),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });
  void app.register(handoffExchangeRoutes, { prefix: '/v1/snippet' });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/snippet/handoff/exchange', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
    // Default: site A resolves
    mockSiteSelect.mockResolvedValue([SITE_A]);
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  // ── Header / key errors ────────────────────────────────────────────────────

  it('returns 403 INVALID_SITE_KEY when X-Site-Key header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: { 'content-type': 'application/json', origin: 'https://site-a.example.com' },
      body: JSON.stringify({ handoff_token: 'wh_ho_validtoken1234567890123456789012345' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });

  it('returns 403 INVALID_SITE_KEY when site key not found in DB', async () => {
    mockSiteSelect.mockResolvedValue([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ handoff_token: 'wh_ho_validtoken1234567890123456789012345' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_SITE_KEY');
  });

  it('returns 403 ORIGIN_NOT_ALLOWED for unlisted origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': SITE_A.siteKey,
        origin: 'https://attacker.com',
      },
      body: JSON.stringify({ handoff_token: 'wh_ho_validtoken1234567890123456789012345' }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  // ── Input validation ───────────────────────────────────────────────────────

  it('returns 400 for a token with invalid prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ handoff_token: 'wh_ml_wrongprefix' }), // ml_ not ho_
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a missing handoff_token field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
  });

  // ── CRITICAL: site mismatch ────────────────────────────────────────────────

  it('returns 403 SITE_MISMATCH when the session belongs to a different site', async () => {
    // The transaction mock returns:
    //   1st select: valid handoff token (not expired, not redeemed)
    //   2nd select: session whose siteId is SITE_B, not SITE_A
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = makeTxMock([
        [VALID_HANDOFF_TOKEN], // handoff token lookup (with .for('update'))
        [SESSION_SITE_B], // session lookup — siteId is SITE_B_ID ≠ SITE_A.id
      ]);
      return cb(tx);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ handoff_token: 'wh_ho_validtoken1234567890123456789012345' }),
    });

    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('SITE_MISMATCH');
  });

  it('does NOT consume the handoff token on SITE_MISMATCH (legitimate site can still use it)', async () => {
    const updateWhere = vi.fn().mockResolvedValue([]);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const txUpdate = vi.fn().mockReturnValue({ set: updateSet });

    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      let callIndex = 0;
      const selectResults = [[VALID_HANDOFF_TOKEN], [SESSION_SITE_B]];
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => makeAwaitable(selectResults[callIndex++] ?? []),
            }),
          }),
        }),
        update: txUpdate,
      };
      return cb(tx);
    });

    await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ handoff_token: 'wh_ho_validtoken1234567890123456789012345' }),
    });

    // UPDATE must NOT have been called — the token is still exchangeable
    expect(txUpdate).not.toHaveBeenCalled();
  });

  // ── Happy path (mocked) ────────────────────────────────────────────────────

  it('returns 200 with session_token and session data on success', async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = makeTxMock([
        [VALID_HANDOFF_TOKEN], // handoff token (with .for('update'))
        [SESSION_SITE_A], // session — same site as requester
        [END_USER], // end_user
      ]);
      return cb(tx);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ handoff_token: 'wh_ho_validtoken1234567890123456789012345' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { session_token: string; session: { id: string; end_user: { email: string } } };
    }>();
    expect(body.data.session_token).toBe(VALID_HANDOFF_TOKEN.rawSessionToken);
    expect(body.data.session.id).toBe(SESSION_SITE_A.id);
    expect(body.data.session.end_user.email).toBe(END_USER.email);
  });

  // ── CORS preflight ─────────────────────────────────────────────────────────

  it('responds 204 to CORS preflight OPTIONS', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://site-a.example.com');
  });

  it('OPTIONS: 204 when clean origin matches despite other noise entries in allowedOrigins', async () => {
    mockSiteSelect.mockResolvedValue([{
      ...SITE_A,
      allowedOrigins: ['https://other.com', 'https://site-a.example.com', 'https://another.com'],
    }]);

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://site-a.example.com');
  });

  it('OPTIONS: 204 when stored origin has a path — normalized to match clean browser origin', async () => {
    // Regression: URLs stored with paths before write-time normalization was
    // enforced would cause CORS to reject a valid origin. The middleware now
    // extracts only the origin portion from stored entries before comparing.
    mockSiteSelect.mockResolvedValue([{
      ...SITE_A,
      allowedOrigins: ['https://other.com', 'https://site-a.example.com/admin.php'],
    }]);

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://site-a.example.com');
  });

  it('OPTIONS: 403 when path-bearing stored entry belongs to a different domain (no accidental match)', async () => {
    // Security check: a stored entry like https://evil.com/https://victim.com
    // must NOT match an Origin of https://victim.com. The URL parser correctly
    // extracts https://evil.com as the origin, so the comparison fails.
    mockSiteSelect.mockResolvedValue([{
      ...SITE_A,
      allowedOrigins: ['https://evil.com/https://site-a.example.com'],
    }]);

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('OPTIONS: 204 when stored origin has trailing slash — normalizes and matches', async () => {
    mockSiteSelect.mockResolvedValue([{
      ...SITE_A,
      allowedOrigins: ['https://site-a.example.com/'],
    }]);

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://site-a.example.com');
  });

  it('sets X-Request-Id on all responses', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/snippet/handoff/exchange',
      headers: {
        'content-type': 'application/json',
        'x-site-key': SITE_A.siteKey,
        origin: 'https://site-a.example.com',
      },
      body: JSON.stringify({ handoff_token: 'wh_ho_validtoken1234567890123456789012345' }),
    });

    expect(res.headers['x-request-id']).toBeTruthy();
  });
});
