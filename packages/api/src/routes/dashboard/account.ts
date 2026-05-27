import { db, siteOwners } from '@wiredhowse/db';
import { ErrorCode, updateAccountSchema } from '@wiredhowse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { send400, sendError } from '../../errors';
import { hashPassword, verifyPassword } from '../../lib/password';
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/dashboard/account
   *
   * Return the current site owner's profile.
   */
  app.get('/account', async (request, reply) => {
    const owner = request.siteOwner;
    if (!owner) return;

    return reply.code(200).send({
      data: {
        id: owner.id,
        email: owner.email,
        display_name: owner.displayName,
        email_verified_at: owner.emailVerifiedAt,
        auth_method: owner.authMethod,
        created_at: owner.createdAt,
        last_login_at: owner.lastLoginAt,
      },
    });
  });

  /**
   * PATCH /v1/dashboard/account
   *
   * Update the current site owner's profile.
   * Supports updating display_name and changing password.
   */
  app.patch('/account', async (request, reply) => {
    const owner = request.siteOwner;
    if (!owner) return;

    const parsed = updateAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      send400(reply, parsed.error.issues[0]?.message ?? 'Invalid request body');
      return;
    }
    const body = parsed.data;

    const updates: Partial<typeof siteOwners.$inferInsert> = {};

    if (body.display_name !== undefined) {
      updates.displayName = body.display_name;
    }

    if (body.new_password !== undefined) {
      const currentPassword = body.current_password;

      // Schema enforces current_password is present when new_password is set,
      // but TypeScript doesn't narrow it — guard explicitly.
      if (currentPassword === undefined) {
        send400(reply, 'current_password is required when setting new_password');
        return;
      }

      // Google-only accounts have no password hash.
      if (owner.passwordHash === null) {
        send400(reply, 'Google-authenticated accounts cannot set a password this way');
        return;
      }

      const valid = await verifyPassword(owner.passwordHash, currentPassword);
      if (!valid) {
        sendError(reply, 400, ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect');
        return;
      }

      updates.passwordHash = await hashPassword(body.new_password);

      // If the owner was Google-only, they now have both auth methods.
      if (owner.authMethod === 'google') {
        updates.authMethod = 'both';
      }
    }

    if (Object.keys(updates).length === 0) {
      // Nothing to update — return current profile unchanged.
      return reply.code(200).send({
        data: {
          id: owner.id,
          email: owner.email,
          display_name: owner.displayName,
          email_verified_at: owner.emailVerifiedAt,
          auth_method: owner.authMethod,
          created_at: owner.createdAt,
          last_login_at: owner.lastLoginAt,
        },
      });
    }

    const [updated] = await db
      .update(siteOwners)
      .set(updates)
      .where(eq(siteOwners.id, owner.id))
      .returning();

    if (!updated) {
      sendError(reply, 500, ErrorCode.INTERNAL_ERROR, 'Failed to update account');
      return;
    }

    return reply.code(200).send({
      data: {
        id: updated.id,
        email: updated.email,
        display_name: updated.displayName,
        email_verified_at: updated.emailVerifiedAt,
        auth_method: updated.authMethod,
        created_at: updated.createdAt,
        last_login_at: updated.lastLoginAt,
      },
    });
  });
}
