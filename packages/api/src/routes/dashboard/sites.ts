import { randomBytes } from 'node:crypto';
import { db, sessions, sites } from '@wiredhowse/db';
import { ErrorCode, createSiteSchema, updateSiteSchema } from '@wiredhowse/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { send400, send404, sendError } from '../../errors';
import { nowUtc } from '../../lib/time';

const SNIPPET_BASE_URL = 'https://magic-link.wiredhowse.app';
const SITE_LIMIT = 3;

function buildSnippetTag(siteKey: string): string {
  return `<script src="${SNIPPET_BASE_URL}/v1/snippet.js" data-site-key="${siteKey}" defer></script>`;
}

function buildVerificationInstructions(
  domain: string,
  verificationToken: string,
): {
  dns: { record_type: string; name: string; value: string };
  meta: { tag: string; placement: string };
} {
  return {
    dns: {
      record_type: 'TXT',
      name: `_wiredhowse-verify.${domain}`,
      value: verificationToken,
    },
    meta: {
      tag: `<meta name="wh-verify" content="${verificationToken}">`,
      placement: 'Inside <head> on your homepage',
    },
  };
}

function formatSiteItem(site: typeof sites.$inferSelect) {
  return {
    id: site.id,
    domain: site.domain,
    state: site.state,
    site_key: site.siteKey,
    verified_at: site.verifiedAt,
    created_at: site.createdAt,
    allowed_origins: site.allowedOrigins,
  };
}

function formatSiteDetail(site: typeof sites.$inferSelect) {
  return {
    id: site.id,
    domain: site.domain,
    state: site.state,
    site_key: site.siteKey,
    verification_token: site.verificationToken,
    verified_at: site.verifiedAt,
    verification_method: site.verificationMethod,
    allowed_origins: site.allowedOrigins,
    disabled_at: site.disabledAt,
    created_at: site.createdAt,
  };
}

const deleteBodySchema = z.object({ confirmation: z.literal('DELETE') });

export async function siteRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/dashboard/sites
   *
   * List all sites owned by the current site owner.
   */
  app.get('/', async (request, reply) => {
    // requireSiteOwnerSession guarantees siteOwner is set.
    const owner = request.siteOwner;
    if (!owner) return;

    const rows = await db.select().from(sites).where(eq(sites.siteOwnerId, owner.id));

    return reply.code(200).send({
      data: {
        sites: rows.map(formatSiteItem),
      },
    });
  });

  /**
   * POST /v1/dashboard/sites
   *
   * Create a new site. Max 3 sites per owner.
   */
  app.post('/', async (request, reply) => {
    const owner = request.siteOwner;
    if (!owner) return;

    const parsed = createSiteSchema.safeParse(request.body);
    if (!parsed.success) {
      send400(reply, parsed.error.issues[0]?.message ?? 'Invalid request body');
      return;
    }
    const { domain } = parsed.data;

    // Enforce max-sites limit.
    const [countRow] = await db
      .select({ count: count() })
      .from(sites)
      .where(eq(sites.siteOwnerId, owner.id));

    if ((countRow?.count ?? 0) >= SITE_LIMIT) {
      sendError(
        reply,
        400,
        ErrorCode.SITE_LIMIT_REACHED,
        'You have reached the maximum of 3 sites',
      );
      return;
    }

    // Check domain uniqueness globally.
    const existing = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.domain, domain))
      .limit(1);

    if (existing.length > 0) {
      sendError(
        reply,
        409,
        ErrorCode.DOMAIN_ALREADY_REGISTERED,
        'This domain is already registered',
      );
      return;
    }

    const siteKey = `pk_${randomBytes(16).toString('base64url')}`;
    const verificationToken = randomBytes(24).toString('base64url');

    const [site] = await db
      .insert(sites)
      .values({
        siteOwnerId: owner.id,
        domain,
        siteKey,
        verificationToken,
        state: 'pending_verification',
        allowedOrigins: [],
      })
      .returning();

    if (!site) {
      sendError(reply, 500, ErrorCode.INTERNAL_ERROR, 'Failed to create site');
      return;
    }

    return reply.code(201).send({
      data: {
        site: {
          id: site.id,
          domain: site.domain,
          state: site.state,
          site_key: site.siteKey,
          snippet_tag: buildSnippetTag(site.siteKey),
          verification_token: site.verificationToken,
          allowed_origins: site.allowedOrigins,
          created_at: site.createdAt,
          verification_instructions: buildVerificationInstructions(
            site.domain,
            site.verificationToken,
          ),
        },
      },
    });
  });

  /**
   * GET /v1/dashboard/sites/:id
   *
   * Get full details for one site. Tenant-scoped.
   */
  app.get('/:id', async (request, reply) => {
    const owner = request.siteOwner;
    if (!owner) return;

    const { id } = request.params as { id: string };

    const [site] = await db
      .select()
      .from(sites)
      .where(and(eq(sites.id, id), eq(sites.siteOwnerId, owner.id)))
      .limit(1);

    if (!site) {
      send404(reply, 'Site not found');
      return;
    }

    return reply.code(200).send({
      data: {
        ...formatSiteDetail(site),
        snippet_tag: buildSnippetTag(site.siteKey),
        verification_instructions: buildVerificationInstructions(
          site.domain,
          site.verificationToken,
        ),
      },
    });
  });

  /**
   * PATCH /v1/dashboard/sites/:id
   *
   * Update allowed_origins or state. Tenant-scoped.
   */
  app.patch('/:id', async (request, reply) => {
    const owner = request.siteOwner;
    if (!owner) return;

    const { id } = request.params as { id: string };

    const parsed = updateSiteSchema.safeParse(request.body);
    if (!parsed.success) {
      send400(reply, parsed.error.issues[0]?.message ?? 'Invalid request body');
      return;
    }
    const body = parsed.data;

    const [site] = await db
      .select()
      .from(sites)
      .where(and(eq(sites.id, id), eq(sites.siteOwnerId, owner.id)))
      .limit(1);

    if (!site) {
      send404(reply, 'Site not found');
      return;
    }

    const updates: Partial<typeof sites.$inferInsert> = {};

    if (body.allowed_origins !== undefined) {
      updates.allowedOrigins = body.allowed_origins;
    }

    if (body.state !== undefined) {
      const currentState = site.state;
      const newState = body.state;

      // Validate state transition.
      const validTransitions: Record<string, string[]> = {
        live: ['disabled'],
        disabled: ['live'],
        pending_verification: [],
      };

      if (validTransitions[currentState]?.includes(newState) !== true) {
        send400(reply, `Invalid state transition: ${currentState} → ${newState}`);
        return;
      }

      // Enabling requires verification.
      if (newState === 'live' && site.verifiedAt === null) {
        send400(reply, 'Domain must be verified before enabling');
        return;
      }

      updates.state = newState;

      if (newState === 'disabled') {
        updates.disabledAt = nowUtc();
      } else if (newState === 'live') {
        updates.disabledAt = null;
      }
    }

    const [updated] = await db
      .update(sites)
      .set(updates)
      .where(and(eq(sites.id, id), eq(sites.siteOwnerId, owner.id)))
      .returning();

    if (!updated) {
      sendError(reply, 500, ErrorCode.INTERNAL_ERROR, 'Failed to update site');
      return;
    }

    return reply.code(200).send({
      data: {
        site: formatSiteDetail(updated),
      },
    });
  });

  /**
   * DELETE /v1/dashboard/sites/:id
   *
   * Delete a site. Requires `{ "confirmation": "DELETE" }` in the request body.
   * Revokes all active sessions before deleting. Cascade handles the rest.
   */
  app.delete('/:id', async (request, reply) => {
    const owner = request.siteOwner;
    if (!owner) return;

    const { id } = request.params as { id: string };

    const confirmParsed = deleteBodySchema.safeParse(request.body);
    if (!confirmParsed.success) {
      sendError(
        reply,
        400,
        ErrorCode.INVALID_CONFIRMATION,
        'Body must be { "confirmation": "DELETE" }',
      );
      return;
    }

    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, id), eq(sites.siteOwnerId, owner.id)))
      .limit(1);

    if (!site) {
      send404(reply, 'Site not found');
      return;
    }

    // Count active (non-revoked) sessions before deletion.
    const now = nowUtc();
    const [countRow] = await db
      .select({ count: count() })
      .from(sessions)
      .where(and(eq(sessions.siteId, site.id), isNull(sessions.revokedAt)));
    const sessionsRevoked = countRow?.count ?? 0;

    // Revoke all active sessions.
    await db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.siteId, site.id), isNull(sessions.revokedAt)));

    // Hard delete — cascades to sessions, magic_links, login_history, handoff_tokens.
    await db.delete(sites).where(and(eq(sites.id, site.id), eq(sites.siteOwnerId, owner.id)));

    return reply.code(200).send({
      data: {
        deleted: true,
        sessions_revoked: sessionsRevoked,
      },
    });
  });
}
