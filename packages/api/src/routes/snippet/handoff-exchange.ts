import { db, endUsers, handoffTokens, sessions, sites } from '@wiredhowse/db';
import { ErrorCode, handoffExchangeSchema, siteKeyHeaderSchema } from '@wiredhowse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { send400, sendError } from '../../errors';
import { hashToken } from '../../lib/crypto';
import { hashForLog } from '../../lib/hashing';
import { nowUtc } from '../../lib/time';
import { applySnippetCors } from '../../middleware/cors';

// ---------------------------------------------------------------------------
// Local error sentinels — caught in the try/catch below, never leaked.
// ---------------------------------------------------------------------------

class HandoffInvalidError extends Error {}
class SiteMismatchError extends Error {}

// ---------------------------------------------------------------------------
// Shared helper: resolve the Site from the X-Site-Key header.
// Duplicated from magic-link-request.ts — extract to a shared snippet helper
// when a third route joins this group.
// ---------------------------------------------------------------------------

type Site = typeof sites.$inferSelect;

async function resolveSite(request: FastifyRequest, reply: FastifyReply): Promise<Site | null> {
  const rawKey = request.headers['x-site-key'];
  if (typeof rawKey !== 'string') {
    sendError(reply, 403, ErrorCode.INVALID_SITE_KEY, 'Missing X-Site-Key header');
    return null;
  }
  const keyParsed = siteKeyHeaderSchema.safeParse(rawKey);
  if (!keyParsed.success) {
    sendError(reply, 403, ErrorCode.INVALID_SITE_KEY, 'Invalid site key format');
    return null;
  }
  const [site] = await db.select().from(sites).where(eq(sites.siteKey, rawKey)).limit(1);
  if (!site) {
    sendError(reply, 403, ErrorCode.INVALID_SITE_KEY, 'Site key not found');
    return null;
  }
  return site;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function handoffExchangeRoutes(app: FastifyInstance): Promise<void> {
  // CORS preflight — browsers send this before the actual POST
  app.options('/handoff/exchange', async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;
    applySnippetCors(request, reply, site.allowedOrigins);
  });

  /**
   * POST /v1/snippet/handoff/exchange
   *
   * Exchanges a single-use handoff token (received by the snippet via the
   * URL fragment after magic-link redemption) for the underlying session token.
   *
   * Security invariants enforced here:
   *  - X-Site-Key must resolve to a known Site.
   *  - Origin must be in that Site's allowed_origins.
   *  - Handoff token must exist, be unexpired, and not yet redeemed.
   *  - The session underneath the handoff token must belong to the same Site as
   *    the requester (SITE_MISMATCH guard prevents cross-site token theft).
   *  - SELECT FOR UPDATE serialises concurrent exchange attempts; only the first
   *    succeeds, the second sees redeemed_at IS NOT NULL and gets 404.
   */
  app.post('/handoff/exchange', async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;

    // CORS / origin enforcement — sends reply and returns false if rejected
    const corsOk = applySnippetCors(request, reply, site.allowedOrigins);
    if (!corsOk) return;

    // Parse and validate request body
    const bodyParsed = handoffExchangeSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      send400(reply, bodyParsed.error.issues[0]?.message ?? 'Invalid request body');
      return;
    }
    const { handoff_token: handoffToken } = bodyParsed.data;

    const tokenHash = hashToken(handoffToken);
    const now = nowUtc();

    try {
      const { sessionToken, session, endUser } = await db.transaction(async (tx) => {
        // SELECT FOR UPDATE — serialises concurrent exchange attempts for the
        // same handoff token. The second concurrent request blocks here until
        // the first transaction commits, then sees redeemed_at IS NOT NULL.
        const [ht] = await tx
          .select()
          .from(handoffTokens)
          .where(eq(handoffTokens.tokenHash, tokenHash))
          .limit(1)
          .for('update');

        if (!ht || ht.redeemedAt !== null || ht.expiresAt < now) {
          throw new HandoffInvalidError();
        }

        // Fetch the underlying session — the cascade FK means if the session
        // was deleted the handoff row would be too, so a missing session is
        // treated as invalid rather than a server error.
        const [sess] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, ht.sessionId))
          .limit(1);

        if (!sess) {
          throw new HandoffInvalidError();
        }

        // CRITICAL: verify the session belongs to the Site making this request.
        // Without this check an attacker who intercepts a handoff token could
        // exchange it against their own Site and obtain the session token.
        if (sess.siteId !== site.id) {
          request.log.warn(
            {
              event: 'handoff_site_mismatch',
              requesterSiteId: site.id,
              sessionSiteIdHash: hashForLog(sess.siteId),
            },
            'Handoff exchange attempted from wrong site — possible token theft',
          );
          throw new SiteMismatchError();
        }

        // Mark the handoff redeemed — single-use enforcement.
        // NOTE: we do NOT consume the token on SiteMismatchError (thrown above).
        // The legitimate site can still exchange it; the attacker's site key
        // gives them nothing.
        await tx.update(handoffTokens).set({ redeemedAt: now }).where(eq(handoffTokens.id, ht.id));

        // Fetch the end_user so we can include profile fields in the response.
        const [user] = await tx
          .select()
          .from(endUsers)
          .where(eq(endUsers.id, sess.endUserId))
          .limit(1);

        if (!user) {
          // Should not happen: the session → end_user FK has ON DELETE CASCADE.
          throw new Error('End user not found for session — data integrity failure');
        }

        return {
          // rawSessionToken is the plaintext wh_s_ token stored at redemption time.
          sessionToken: ht.rawSessionToken,
          session: sess,
          endUser: user,
        };
      });

      return reply.code(200).send({
        data: {
          session_token: sessionToken,
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
    } catch (err) {
      if (err instanceof HandoffInvalidError) {
        sendError(
          reply,
          404,
          ErrorCode.HANDOFF_NOT_FOUND,
          'Handoff token not found, expired, or already used',
        );
        return;
      }
      if (err instanceof SiteMismatchError) {
        sendError(reply, 403, ErrorCode.SITE_MISMATCH, 'Handoff token belongs to a different site');
        return;
      }
      request.log.error({ err }, 'Unexpected error during handoff exchange');
      sendError(reply, 500, ErrorCode.INTERNAL_ERROR, 'Internal server error');
    }
  });
}
