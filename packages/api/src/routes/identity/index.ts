import { ErrorCode } from '@wiredhowse/shared';
import type { FastifyInstance } from 'fastify';
import { sendError } from '../../errors';
import { requireEndUserSession } from '../../middleware/auth-session';

/**
 * SSO identity contract — /v1/identity/*
 *
 * Other wiredHowse apps (future) call GET /v1/identity/me with a valid End User
 * session token to retrieve the End User's profile. This is the stable v1
 * cross-app contract.
 *
 * The data shape is intentionally identical to GET /v1/me. They are separate
 * endpoints so that:
 *  - /v1/me can evolve (add mutable fields, self-service actions) without
 *    risk of breaking the SSO contract.
 *  - /v1/identity/me can be versioned independently (/v2/identity/me) if the
 *    SSO profile shape ever changes.
 *
 * Auth: Bearer wh_s_<token> — same as /v1/me. No cookies.
 */
export async function identityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireEndUserSession);

  /**
   * GET /v1/identity/me
   *
   * Stable SSO contract. Treat this as a public-ish API surface — other
   * wiredHowse services depend on this exact shape. Do not remove or rename
   * fields without a versioned migration plan.
   */
  app.get('/me', async (request, reply) => {
    const user = request.endUser;
    if (!user) {
      sendError(reply, 401, ErrorCode.UNAUTHENTICATED, 'Not authenticated');
      return;
    }

    return reply.code(200).send({
      data: {
        id: user.id,
        email: user.email,
        email_verified_at: user.emailVerifiedAt,
        display_name: user.displayName,
        created_at: user.createdAt,
        last_seen_at: user.lastSeenAt,
      },
    });
  });
}
