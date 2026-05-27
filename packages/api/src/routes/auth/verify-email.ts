import { db, emailVerifications, siteOwners } from '@wiredhowse/db';
import { ErrorCode, verifyEmailSchema } from '@wiredhowse/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { send400, sendError } from '../../errors';
import { hashToken } from '../../lib/crypto';
import { nowUtc } from '../../lib/time';

// wh_ev_ + base64url(32 bytes)
const EMAIL_VERIFY_TOKEN_RE = /^wh_ev_[A-Za-z0-9_-]{30,}$/;

export async function verifyEmailRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/verify-email
   *
   * Verifies a Site Owner's email address via the wh_ev_ token sent at signup
   * or after an email change. Marks email_verified_at on the account.
   */
  app.post('/verify-email', async (request, reply) => {
    const parsed = verifyEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      send400(reply, parsed.error.issues[0]?.message ?? 'Invalid token');
      return;
    }
    const { token } = parsed.data;

    if (!EMAIL_VERIFY_TOKEN_RE.test(token)) {
      sendError(reply, 404, ErrorCode.INVALID_TOKEN, 'Verification link is invalid or has expired');
      return;
    }

    const tokenHash = hashToken(token);
    const now = nowUtc();

    // Find a valid, un-verified token.
    const [ev] = await db
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.tokenHash, tokenHash),
          gt(emailVerifications.expiresAt, now),
          isNull(emailVerifications.verifiedAt),
        ),
      )
      .limit(1);

    if (!ev) {
      sendError(reply, 404, ErrorCode.INVALID_TOKEN, 'Verification link is invalid or has expired');
      return;
    }

    // Mark the verification row consumed and set email_verified_at on the account.
    await db
      .update(emailVerifications)
      .set({ verifiedAt: now })
      .where(eq(emailVerifications.id, ev.id));

    await db
      .update(siteOwners)
      .set({ emailVerifiedAt: now })
      .where(eq(siteOwners.id, ev.siteOwnerId));

    return reply.code(200).send({ data: { verified: true } });
  });
}
