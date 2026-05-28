import {
  db,
  endUsers,
  handoffTokens,
  loginHistory,
  magicLinks,
  sessions,
  sites,
} from '@wiredhowse/db';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { generateToken, hashToken } from '../../lib/crypto';
import { hashBytes, hashForLog } from '../../lib/hashing';
import { addSeconds, nowUtc } from '../../lib/time';
import { loginTierDuration } from '../../services/login-tier';
import { renderErrorHtml } from './error-page';

const ML_TOKEN_RE = /^wh_ml_[A-Za-z0-9_-]+$/;
const HTML = 'text/html; charset=utf-8';

class MagicLinkInvalidError extends Error {}
class SiteNotLiveError extends Error {}

export async function magicRedeemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/redeem', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');

    const token = (request.query as Record<string, string>).token;

    if (!token || !ML_TOKEN_RE.test(token)) {
      return reply
        .code(404)
        .type(HTML)
        .send(
          renderErrorHtml(
            'Link expired or already used',
            'This magic link has expired or has already been used. Please return to the site and request a new one.',
          ),
        );
    }

    const tokenHash = hashToken(token);
    const redeemedIpHash = hashBytes(request.ip);
    const uaHash = hashBytes(request.headers['user-agent'] ?? '');

    try {
      const { handoffTokenRaw, redirectOrigin, requestedIpHash } = await db.transaction(
        async (tx) => {
          // SELECT FOR UPDATE prevents a concurrent request from redeeming the same link
          const [ml] = await tx
            .select()
            .from(magicLinks)
            .where(eq(magicLinks.tokenHash, tokenHash))
            .limit(1)
            .for('update');

          if (!ml || ml.redeemedAt !== null || ml.expiresAt < nowUtc()) {
            throw new MagicLinkInvalidError();
          }

          const [site] = await tx.select().from(sites).where(eq(sites.id, ml.siteId)).limit(1);

          if (!site || site.state !== 'live' || site.allowedOrigins.length === 0) {
            throw new SiteNotLiveError();
          }

          const now = nowUtc();

          // Find or create end_user by email (case-insensitive via citext)
          const [existingUser] = await tx
            .select()
            .from(endUsers)
            .where(eq(endUsers.email, ml.email))
            .limit(1);

          let endUser: typeof endUsers.$inferSelect;
          if (existingUser) {
            endUser = existingUser;
          } else {
            const [inserted] = await tx
              .insert(endUsers)
              .values({ email: ml.email, emailVerifiedAt: now })
              .onConflictDoNothing()
              .returning();
            if (inserted) {
              endUser = inserted;
            } else {
              // Another concurrent transaction created the user first
              const [refetched] = await tx
                .select()
                .from(endUsers)
                .where(eq(endUsers.email, ml.email))
                .limit(1);
              if (!refetched) throw new Error('Failed to find or create end_user');
              endUser = refetched;
            }
          }

          // Count previous logins for this user on this site — determines session tier
          const countRows = await tx
            .select({ n: sql<number>`cast(count(*) as integer)` })
            .from(loginHistory)
            .where(and(eq(loginHistory.endUserId, endUser.id), eq(loginHistory.siteId, site.id)));
          const priorLoginCount = countRows[0]?.n ?? 0;

          const durationSec = loginTierDuration(priorLoginCount);
          const sessionExpiresAt = addSeconds(now, durationSec);

          // INSERT session with pre-computed expiry
          const sessionTokenRaw = generateToken('wh_s_');
          const sessionTokenHash = hashToken(sessionTokenRaw);

          const [session] = await tx
            .insert(sessions)
            .values({
              endUserId: endUser.id,
              siteId: site.id,
              tokenHash: sessionTokenHash,
              expiresAt: sessionExpiresAt,
              loginCountAtCreation: priorLoginCount,
              ipHash: redeemedIpHash,
              userAgentHash: uaHash,
            })
            .returning({ id: sessions.id });

          if (!session) throw new Error('Session INSERT returned no row');
          const sessionId = session.id;

          // INSERT handoff_token — 60-second bridge back to the snippet.
          // rawSessionToken stores the plaintext wh_s_ token so the exchange
          // endpoint can return it. It is inert after redeemed_at is set and
          // is purged by the cleanup cron after 1 hour.
          const hoTokenRaw = generateToken('wh_ho_');
          const hoTokenHash = hashToken(hoTokenRaw);
          await tx.insert(handoffTokens).values({
            sessionId,
            tokenHash: hoTokenHash,
            rawSessionToken: sessionTokenRaw,
            expiresAt: addSeconds(now, 60),
          });

          // INSERT login_history — counts future logins for tier calculation
          await tx.insert(loginHistory).values({
            endUserId: endUser.id,
            siteId: site.id,
            sessionId,
            ipHash: redeemedIpHash,
          });

          // Mark magic link redeemed — must be last to keep rollback semantics clean
          await tx
            .update(magicLinks)
            .set({ redeemedAt: now, redeemedIpHash })
            .where(eq(magicLinks.id, ml.id));

          // allowedOrigins.length > 0 is already checked above; this is a safety guard.
          const redirectOrigin = site.allowedOrigins[0];
          if (!redirectOrigin) throw new SiteNotLiveError();

          return {
            handoffTokenRaw: hoTokenRaw,
            redirectOrigin,
            requestedIpHash: ml.requestedIpHash,
          };
        },
      );

      // Informational only — flag cross-IP redemptions for abuse review
      if (!Buffer.from(requestedIpHash).equals(redeemedIpHash)) {
        request.log.warn(
          { event: 'ip_mismatch_on_redeem', requestIpHash: hashForLog(request.ip) },
          'Magic-link redemption IP differs from request IP',
        );
      }

      // Fragment is preserved across 302 redirects by all current browsers.
      // Using a fragment (not query string) prevents the handoff token from being
      // sent to the origin server as a query parameter or appearing in server logs.
      const location = `${redirectOrigin}#wh_handoff=${handoffTokenRaw}`;
      return reply.code(302).header('Location', location).send('');
    } catch (err) {
      if (err instanceof SiteNotLiveError) {
        return reply
          .code(410)
          .type(HTML)
          .send(
            renderErrorHtml(
              'Site not available',
              'This site is no longer protected by magic-link authentication.',
            ),
          );
      }
      if (err instanceof MagicLinkInvalidError) {
        return reply
          .code(404)
          .type(HTML)
          .send(
            renderErrorHtml(
              'Link expired or already used',
              'This magic link has expired or has already been used. Please return to the site and request a new one.',
            ),
          );
      }
      request.log.error({ err }, 'Unexpected error during magic-link redemption');
      return reply
        .code(500)
        .type(HTML)
        .send(
          renderErrorHtml(
            'Something went wrong',
            'An unexpected error occurred. Please try again or request a new magic link.',
          ),
        );
    }
  });
}
