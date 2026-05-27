import { db, passwordResets, siteOwnerSessions, siteOwners } from '@wiredhowse/db';
import {
  ErrorCode,
  requestPasswordResetSchema,
  resetPasswordSchema,
} from '@wiredhowse/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config';
import { send400, sendError } from '../../errors';
import { generateToken, hashToken } from '../../lib/crypto';
import { hashForLog } from '../../lib/hashing';
import { hashPassword } from '../../lib/password';
import { addHours, nowUtc } from '../../lib/time';
import { sendPasswordResetEmail } from '../../services/email';
import {
  checkGenericPerIp,
  checkPasswordResetPerEmail,
  setRateLimitHeaders,
} from '../../services/rate-limit';

const PASSWORD_RESET_TTL_HOURS = 1;
const PASSWORD_RESET_TOKEN_RE = /^wh_pr_[A-Za-z0-9_-]{30,}$/;

export async function passwordResetRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/request-password-reset
   *
   * Sends a password reset email. Always returns 200 regardless of whether
   * the email is registered — prevents account enumeration.
   */
  app.post('/request-password-reset', async (request, reply) => {
    const ip = request.ip;

    const ipResult = await checkGenericPerIp(ip);
    setRateLimitHeaders(reply, {
      limit: ipResult.limit,
      remaining: Math.max(0, ipResult.limit - ipResult.current),
      reset: ipResult.resetAt,
    });
    if (!ipResult.allowed) {
      const retryAfter = Math.max(1, ipResult.resetAt - Math.floor(Date.now() / 1000));
      sendError(reply, 429, ErrorCode.RATE_LIMITED, 'Too many requests', {
        retry_after_seconds: retryAfter,
      });
      return;
    }

    const parsed = requestPasswordResetSchema.safeParse(request.body);
    if (!parsed.success) {
      send400(reply, parsed.error.issues[0]?.message ?? 'Invalid request body');
      return;
    }
    const { email } = parsed.data;

    // Per-email rate limit is silent — always return 200 to prevent enumeration.
    const emailResult = await checkPasswordResetPerEmail(email);

    if (emailResult.allowed) {
      // Find account — silently swallow "not found" to prevent enumeration.
      const [owner] = await db
        .select({ id: siteOwners.id })
        .from(siteOwners)
        .where(eq(siteOwners.email, email))
        .limit(1);

      if (owner) {
        const rawToken = generateToken('wh_pr_');
        const tokenHash = hashToken(rawToken);
        const expiresAt = addHours(nowUtc(), PASSWORD_RESET_TTL_HOURS);

        await db.insert(passwordResets).values({
          siteOwnerId: owner.id,
          tokenHash,
          expiresAt,
        });

        const resetUrl = `${config.SITE_URL}/reset-password?token=${encodeURIComponent(rawToken)}`;

        sendPasswordResetEmail({ to: email, resetUrl, expiresInHours: PASSWORD_RESET_TTL_HOURS }).catch(
          (err: unknown) => {
            request.log.error(
              { err, ownerId: owner.id },
              'request-password-reset: failed to send email',
            );
          },
        );
      } else {
        request.log.info(
          { event: 'password_reset_unknown_email', emailHash: hashForLog(email) },
          'Password reset requested for unknown email — silently ignored',
        );
      }
    } else {
      request.log.info(
        { event: 'password_reset_silent_blocked', emailHash: hashForLog(email) },
        'Password reset silently rate-limited',
      );
    }

    // Always 200 — never reveal whether the email exists.
    return reply.code(200).send({
      data: { sent: true },
    });
  });

  /**
   * POST /v1/auth/reset-password
   *
   * Resets a Site Owner's password using a wh_pr_ token.
   * Revokes all existing dashboard sessions as a security measure.
   */
  app.post('/reset-password', async (request, reply) => {
    const parsed = resetPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      send400(reply, parsed.error.issues[0]?.message ?? 'Invalid request body');
      return;
    }
    const { token, new_password } = parsed.data;

    if (!PASSWORD_RESET_TOKEN_RE.test(token)) {
      sendError(reply, 404, ErrorCode.INVALID_TOKEN, 'Reset link is invalid or has expired');
      return;
    }

    const tokenHash = hashToken(token);
    const now = nowUtc();

    const [reset] = await db
      .select()
      .from(passwordResets)
      .where(
        and(
          eq(passwordResets.tokenHash, tokenHash),
          gt(passwordResets.expiresAt, now),
          isNull(passwordResets.usedAt),
        ),
      )
      .limit(1);

    if (!reset) {
      sendError(reply, 404, ErrorCode.INVALID_TOKEN, 'Reset link is invalid or has expired');
      return;
    }

    const newHash = await hashPassword(new_password);

    // Fetch current auth_method to set the correct new value.
    const [owner] = await db
      .select({ authMethod: siteOwners.authMethod })
      .from(siteOwners)
      .where(eq(siteOwners.id, reset.siteOwnerId))
      .limit(1);

    const newAuthMethod =
      owner?.authMethod === 'google' ? 'both' : (owner?.authMethod ?? 'password');

    await db
      .update(siteOwners)
      .set({ passwordHash: newHash, authMethod: newAuthMethod, emailVerifiedAt: now })
      .where(eq(siteOwners.id, reset.siteOwnerId));

    await db
      .update(passwordResets)
      .set({ usedAt: now })
      .where(eq(passwordResets.id, reset.id));

    // Revoke all existing sessions as a security measure.
    await db
      .update(siteOwnerSessions)
      .set({ revokedAt: now })
      .where(eq(siteOwnerSessions.siteOwnerId, reset.siteOwnerId));

    return reply.code(200).send({ data: { reset: true } });
  });
}
