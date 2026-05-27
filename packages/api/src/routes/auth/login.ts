import { db, siteOwnerSessions, siteOwners } from '@wiredhowse/db';
import { ErrorCode, loginSchema } from '@wiredhowse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { send400, sendError } from '../../errors';
import { generateToken, hashToken } from '../../lib/crypto';
import { buildOwnerSessionCookie } from '../../lib/cookies';
import { hashBytes, hashForLog } from '../../lib/hashing';
import { dummyVerify, verifyPassword } from '../../lib/password';
import { addDays, addHours, nowUtc } from '../../lib/time';
import {
  checkOwnerLoginPerEmail,
  checkOwnerLoginPerIp,
  setRateLimitHeaders,
} from '../../services/rate-limit';

const LOCKOUT_THRESHOLD = 10;

export async function loginRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/login
   *
   * Authenticates a Site Owner with email + password.
   * On success: creates a 30-day sliding dashboard session, sets wh_owner_session cookie.
   * On failure: increments failed attempt counter; locks account after 10 failures / hour.
   *
   * Timing-attack protection: always runs an argon2 verify even when no account is found.
   * Both "wrong email" and "wrong password" return the same INVALID_CREDENTIALS error.
   */
  app.post('/login', async (request, reply) => {
    const ip = request.ip;

    // Per-IP rate limit first — 20 req/min.
    const ipResult = await checkOwnerLoginPerIp(ip);
    setRateLimitHeaders(reply, {
      limit: ipResult.limit,
      remaining: Math.max(0, ipResult.limit - ipResult.current),
      reset: ipResult.resetAt,
    });
    if (!ipResult.allowed) {
      const retryAfter = Math.max(1, ipResult.resetAt - Math.floor(Date.now() / 1000));
      sendError(reply, 429, ErrorCode.RATE_LIMITED, 'Too many login attempts. Try again later.', {
        retry_after_seconds: retryAfter,
      });
      return;
    }

    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      send400(reply, parsed.error.issues[0]?.message ?? 'Invalid request body');
      return;
    }
    const { email, password } = parsed.data;

    // Per-email rate limit — 10/hr. This feeds into the account lockout.
    const emailResult = await checkOwnerLoginPerEmail(email);
    setRateLimitHeaders(reply, {
      limit: emailResult.limit,
      remaining: Math.max(0, emailResult.limit - emailResult.current),
      reset: emailResult.resetAt,
    });
    if (!emailResult.allowed) {
      const retryAfter = Math.max(1, emailResult.resetAt - Math.floor(Date.now() / 1000));
      sendError(
        reply,
        429,
        ErrorCode.RATE_LIMITED,
        'Too many login attempts for this account. Try again later.',
        { retry_after_seconds: retryAfter },
      );
      return;
    }

    // Look up the account.
    const [owner] = await db
      .select()
      .from(siteOwners)
      .where(eq(siteOwners.email, email))
      .limit(1);

    if (!owner) {
      // Dummy verify — maintain constant timing so the caller can't enumerate emails.
      await dummyVerify();
      sendError(reply, 401, ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password');
      return;
    }

    // Check DB-level account lock (set when failedLoginCount >= 10).
    const now = nowUtc();
    if (owner.lockedUntil && owner.lockedUntil > now) {
      const secsRemaining = Math.ceil((owner.lockedUntil.getTime() - now.getTime()) / 1000);
      sendError(
        reply,
        423,
        ErrorCode.ACCOUNT_LOCKED,
        'Account locked due to too many failed attempts.',
        { locked_until: owner.lockedUntil.toISOString(), retry_after_seconds: secsRemaining },
      );
      return;
    }

    // Email must be verified before password login.
    if (!owner.emailVerifiedAt) {
      sendError(
        reply,
        403,
        ErrorCode.EMAIL_NOT_VERIFIED,
        'Please verify your email address before logging in. Check your inbox for the verification link.',
      );
      return;
    }

    // Password auth only for accounts that have a password.
    if (!owner.passwordHash) {
      // Account was created via Google OAuth — direct them to that flow.
      sendError(
        reply,
        403,
        ErrorCode.INVALID_CREDENTIALS,
        'This account uses Google sign-in. Please log in with Google.',
      );
      return;
    }

    const passwordOk = await verifyPassword(owner.passwordHash, password);

    if (!passwordOk) {
      // Increment failure counter; lock if threshold reached.
      const newCount = owner.failedLoginCount + 1;
      const shouldLock = newCount >= LOCKOUT_THRESHOLD;
      await db
        .update(siteOwners)
        .set({
          failedLoginCount: newCount,
          lockedUntil: shouldLock ? addHours(now, 1) : null,
        })
        .where(eq(siteOwners.id, owner.id));

      request.log.warn(
        {
          event: 'login_failure',
          ownerId: owner.id,
          emailHash: hashForLog(email),
          attempt: newCount,
          locked: shouldLock,
        },
        'Failed login attempt',
      );

      if (shouldLock) {
        sendError(
          reply,
          423,
          ErrorCode.ACCOUNT_LOCKED,
          'Account locked after too many failed attempts. Try again in 1 hour.',
          { retry_after_seconds: 3600 },
        );
        return;
      }

      sendError(reply, 401, ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password');
      return;
    }

    // Success — reset failure counter and create session.
    await db
      .update(siteOwners)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
      })
      .where(eq(siteOwners.id, owner.id));

    const rawSessionToken = generateToken('wh_dsess_');
    const sessionTokenHash = hashToken(rawSessionToken);
    const expiresAt = addDays(now, 30);

    const [session] = await db
      .insert(siteOwnerSessions)
      .values({
        siteOwnerId: owner.id,
        tokenHash: sessionTokenHash,
        expiresAt,
        ipHash: hashBytes(ip),
        userAgentHash: hashBytes(request.headers['user-agent'] ?? ''),
      })
      .returning({ id: siteOwnerSessions.id });

    if (!session) {
      sendError(reply, 500, ErrorCode.INTERNAL_ERROR, 'Failed to create session');
      return;
    }

    void reply.header('Set-Cookie', buildOwnerSessionCookie(rawSessionToken));

    request.log.info(
      { event: 'login_success', ownerId: owner.id, sessionId: session.id },
      'Site Owner logged in',
    );

    return reply.code(200).send({
      data: {
        site_owner: {
          id: owner.id,
          email: owner.email,
          display_name: owner.displayName,
          auth_method: owner.authMethod,
          email_verified_at: owner.emailVerifiedAt?.toISOString() ?? null,
          created_at: owner.createdAt.toISOString(),
          last_login_at: now.toISOString(),
        },
      },
    });
  });
}
