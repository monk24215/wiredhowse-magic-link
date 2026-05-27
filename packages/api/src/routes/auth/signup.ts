import {
  db,
  emailVerifications,
  siteOwners,
} from '@wiredhowse/db';
import { ErrorCode, signupSchema } from '@wiredhowse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config';
import { send400, sendError } from '../../errors';
import { generateToken, hashToken } from '../../lib/crypto';
import { hashForLog } from '../../lib/hashing';
import { hashPassword } from '../../lib/password';
import { addHours, nowUtc } from '../../lib/time';
import { sendEmailVerificationEmail } from '../../services/email';
import { checkGenericPerIp, setRateLimitHeaders } from '../../services/rate-limit';

const EMAIL_VERIFICATION_TTL_HOURS = 24;

export async function signupRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/signup
   *
   * Creates a new Site Owner account. Sends an email verification link.
   * The account is usable for login only after email is verified.
   *
   * Rate limit: generic IP limit (30/sec) to prevent spray attacks.
   */
  app.post('/signup', async (request, reply) => {
    // Generic per-IP rate limit — 30/sec covers most abuse patterns.
    const ipResult = await checkGenericPerIp(request.ip);
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

    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) {
      send400(reply, parsed.error.issues[0]?.message ?? 'Invalid request body');
      return;
    }
    const { email, password } = parsed.data;

    // Check for existing account. Clear error is acceptable here — the user
    // is providing their own email, so this isn't enumeration.
    const existing = await db
      .select({ id: siteOwners.id })
      .from(siteOwners)
      .where(eq(siteOwners.email, email))
      .limit(1);

    if (existing.length > 0) {
      sendError(reply, 409, ErrorCode.EMAIL_ALREADY_REGISTERED, 'This email is already registered. Please log in.');
      return;
    }

    const passwordHash = await hashPassword(password);

    const [owner] = await db
      .insert(siteOwners)
      .values({
        email,
        passwordHash,
        authMethod: 'password',
      })
      .returning({ id: siteOwners.id });

    if (!owner) {
      request.log.error({ emailHash: hashForLog(email) }, 'signup: INSERT returned no row');
      sendError(reply, 500, ErrorCode.INTERNAL_ERROR, 'Failed to create account');
      return;
    }

    // Issue email verification token
    const rawToken = generateToken('wh_ev_');
    const tokenHash = hashToken(rawToken);
    const expiresAt = addHours(nowUtc(), EMAIL_VERIFICATION_TTL_HOURS);

    await db.insert(emailVerifications).values({
      siteOwnerId: owner.id,
      email,
      tokenHash,
      expiresAt,
    });

    const verifyUrl = `${config.SITE_URL}/verify?token=${encodeURIComponent(rawToken)}`;

    // Non-blocking — email failure must not block the 201 response.
    sendEmailVerificationEmail({
      to: email,
      verifyUrl,
      expiresInHours: EMAIL_VERIFICATION_TTL_HOURS,
    }).catch((err: unknown) => {
      request.log.error(
        { err, ownerId: owner.id },
        'signup: failed to send verification email',
      );
    });

    return reply.code(201).send({
      data: {
        message: 'Account created. Check your email to verify your address before logging in.',
      },
    });
  });
}
