import { db, sessions } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sendError } from '../../errors';
import { hashToken } from '../../lib/crypto';
import { nowUtc } from '../../lib/time';
import { applySnippetCors } from '../../middleware/cors';
import { checkGenericPerIp, setRateLimitHeaders } from '../../services/rate-limit';
import { resolveSite } from './shared';

// wh_s_ prefix + base64url(32 bytes) ≈ 48 chars total; allow a little slack.
const SESSION_TOKEN_RE = /^wh_s_[A-Za-z0-9_-]{30,}$/;

export async function signOutRoutes(app: FastifyInstance): Promise<void> {
  // CORS preflight — browsers send OPTIONS before the actual POST
  app.options('/sign-out', async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;
    applySnippetCors(request, reply, site.allowedOrigins);
  });

  /**
   * POST /v1/snippet/sign-out
   *
   * Revokes the current End User session. Unlike the other snippet endpoints
   * this one requires `Authorization: Bearer wh_s_<token>` — returns 401 if
   * the header is absent. Idempotent: already-revoked, non-existent, or
   * malformed tokens all return 200 { signed_out: true } to avoid leaking
   * whether a session was live.
   *
   * Security invariants enforced here:
   *  - X-Site-Key must resolve to a known Site.
   *  - Origin must be in that Site's allowed_origins.
   *  - Rate limited: 30 requests/IP/second (checkGenericPerIp).
   *  - Missing Authorization header: 401 UNAUTHENTICATED.
   *  - Malformed token format: 200 { signed_out: true } — no DB hit, no leak.
   *  - Revocation WHERE clause includes site_id: a token from Site A cannot
   *    be revoked via Site B's site key (defense-in-depth cross-site guard).
   *  - Idempotent: already-revoked or non-existent tokens return 200 (the
   *    UPDATE is simply a no-op, which is indistinguishable to the caller).
   */
  app.post('/sign-out', async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;

    // CORS / origin enforcement — sends reply and returns false if rejected
    const corsOk = applySnippetCors(request, reply, site.allowedOrigins);
    if (!corsOk) return;

    // Rate limit: 30 per IP per second
    const ip = request.ip;
    const rlResult = await checkGenericPerIp(ip);
    setRateLimitHeaders(reply, {
      limit: rlResult.limit,
      remaining: Math.max(0, rlResult.limit - rlResult.current),
      reset: rlResult.resetAt,
    });
    if (!rlResult.allowed) {
      const retryAfter = Math.max(1, rlResult.resetAt - Math.floor(Date.now() / 1000));
      setRateLimitHeaders(reply, {
        limit: rlResult.limit,
        remaining: 0,
        reset: rlResult.resetAt,
        retryAfter,
      });
      sendError(
        reply,
        429,
        ErrorCode.RATE_LIMITED,
        `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
        { retry_after_seconds: retryAfter },
      );
      return;
    }

    // Authorization header required — this is the one auth-gated snippet endpoint.
    const auth = request.headers.authorization;
    if (!auth) {
      sendError(reply, 401, ErrorCode.UNAUTHENTICATED, 'Missing Authorization header');
      return;
    }

    // Extract the raw token from the Bearer scheme. A non-Bearer value or a
    // value that doesn't match the wh_s_ regex is treated as a malformed token
    // and returns 200 — idempotent, no information leak.
    const rawToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';

    if (!rawToken || !SESSION_TOKEN_RE.test(rawToken)) {
      return reply.code(200).send({ data: { signed_out: true } });
    }

    const tokenHash = hashToken(rawToken);
    const now = nowUtc();

    // Revoke the session. The WHERE conditions mean the UPDATE is a no-op when:
    //  - The token hash doesn't match any row (non-existent token).
    //  - The session is already revoked (revoked_at IS NOT NULL).
    //  - The session belongs to a different Site (site_id guard).
    // In all cases we return 200 — the caller's goal (signed out) is satisfied.
    await db
      .update(sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          eq(sessions.siteId, site.id),
        ),
      );

    return reply.code(200).send({ data: { signed_out: true } });
  });
}
