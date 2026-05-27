import { db, endUsers } from '@wiredhowse/db';
import { ErrorCode, updateMeSchema } from '@wiredhowse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { send400, send500, sendError } from '../../errors';

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/me
   *
   * Returns the authenticated End User's identity profile.
   */
  app.get('/', async (request, reply) => {
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

  /**
   * PATCH /v1/me
   *
   * Updates the authenticated End User's profile. Only `display_name` is
   * mutable in v1 — email change is deferred to v2.
   */
  app.patch('/', async (request, reply) => {
    const user = request.endUser;
    if (!user) {
      sendError(reply, 401, ErrorCode.UNAUTHENTICATED, 'Not authenticated');
      return;
    }

    const parsed = updateMeSchema.safeParse(request.body);
    if (!parsed.success) {
      send400(reply, parsed.error.issues[0]?.message ?? 'Invalid request body');
      return;
    }

    const { display_name } = parsed.data;

    // Nothing to update — return unchanged profile.
    if (display_name === undefined) {
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
    }

    const [updated] = await db
      .update(endUsers)
      .set({ displayName: display_name ?? null })
      .where(eq(endUsers.id, user.id))
      .returning();

    if (!updated) {
      send500(reply, 'Failed to update profile');
      return;
    }

    return reply.code(200).send({
      data: {
        id: updated.id,
        email: updated.email,
        email_verified_at: updated.emailVerifiedAt,
        display_name: updated.displayName,
        created_at: updated.createdAt,
        last_seen_at: updated.lastSeenAt,
      },
    });
  });
}
