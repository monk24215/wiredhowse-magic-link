import { db, endUsers, sessions } from '@wiredhowse/db';
import { ErrorCode, sessionCheckBodySchema } from '@wiredhowse/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sendError } from '../../errors';
import { hashToken } from '../../lib/crypto';
import { nowUtc } from '../../lib/time';
import { applySnippetCors } from '../../middleware/cors';
import { checkSessionCheckPerIp, setRateLimitHeaders } from '../../services/rate-limit';
import { resolveSite } from './shared';

// wh_s_ prefix + base64url(32 bytes) ≈ 48 chars total; allow a little slack.
const SESSION_TOKEN_RE = /^wh_s_[A-Za-z0-9_-]{30,}$/;

export async function sessionCheckRoutes(app: FastifyInstance): Promise<void> {
  // CORS preflight — browsers send OPTIONS before the actual POST
  app.options('/session/check', async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;
    applySnippetCors(request, reply, site.allowedOrigins);
  });

  /**
   * POST /v1/snippet/session/check
   *
   * Validates an existing session token on behalf of the snippet. Called on
   * every page load to determine whether the End User already has a live session.
   *
   * Security invariants enforced here:
   *  - X-Site-Key must resolve to a known Site.
   *  - Origin must be in that Site's allowed_origins.
   *  - Rate limited: 120 requests/IP/minute.
   *  - Token is looked up against sessions WHERE:
   *      token_hash = sha256(rawToken)
   *      AND revoked_at IS NULL
   *      AND expires_at > now()
   *      AND site_id = (site resolved from X-Site-Key)   ← defense-in-depth;
   *        prevents a stolen wh_s_ token from Site A authenticating on Site B.
   *  - On valid: side-effect updates last_used_at / last_seen_at.
   *  - On invalid (any reason, including bad format, not found, expired, revoked,
   *    wrong-site): returns { valid: false } with 200. Not 401. The question is
   *    "is this token valid for this site?" and "no" is informational.
   */
  app.post('/session/check', async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;

    // CORS / origin enforcement — sends reply and returns false if rejected
    const corsOk = applySnippetCors(request, reply, site.allowedOrigins);
    if (!corsOk) return;

    // Rate limit: 120 per IP per minute (spec/07)
    const ip = request.ip;
    const rlResult = await checkSessionCheckPerIp(ip);
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

    // Parse body — both absent body and `{}` are valid "no session" inputs.
    // We use ?? {} so that a missing body parses as the schema's default `{}`.
    const bodyParsed = sessionCheckBodySchema.safeParse(request.body ?? {});
    const rawToken = bodyParsed.success ? bodyParsed.data?.token : undefined;

    // Absent or format-invalid token → valid: false, no DB round-trip.
    // Treating bad format as "not found" prevents leaking schema details.
    if (!rawToken || !SESSION_TOKEN_RE.test(rawToken)) {
      return reply.code(200).send({ data: { valid: false } });
    }

    const tokenHash = hashToken(rawToken);
    const now = nowUtc();

    // Lookup in one query: hash + not revoked + not expired + correct site.
    // The site_id predicate is defense-in-depth: tokens are 256-bit random and
    // practically non-guessable, but the site check costs almost nothing and
    // ensures a token from Site A cannot validate against Site B.
    const [session] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          eq(sessions.siteId, site.id),
        ),
      )
      .limit(1);

    if (!session) {
      return reply.code(200).send({ data: { valid: false } });
    }

    // Update usage timestamps. Per spec: does NOT extend expires_at (fixed at issuance).
    await db.update(sessions).set({ lastUsedAt: now }).where(eq(sessions.id, session.id));

    // Fetch end_user for the response payload.
    const [endUser] = await db
      .select()
      .from(endUsers)
      .where(eq(endUsers.id, session.endUserId))
      .limit(1);

    if (!endUser) {
      // FK cascade means this should never happen. Treat as invalid rather than 500.
      request.log.error(
        { sessionId: session.id },
        'session/check: session found but end_user row missing — possible data integrity issue',
      );
      return reply.code(200).send({ data: { valid: false } });
    }

    await db.update(endUsers).set({ lastSeenAt: now }).where(eq(endUsers.id, endUser.id));

    return reply.code(200).send({
      data: {
        valid: true,
        session: {
          id: session.id,
          expires_at: session.expiresAt.toISOString(),
          end_user: {
            id: endUser.id,
            email: endUser.email,
            display_name: endUser.displayName,
          },
        },
      },
    });
  });
}
