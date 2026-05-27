/**
 * Shared helpers for /v1/snippet/* routes.
 *
 * Extracted here when the third route (session/check) joined the group, as
 * noted in the earlier TODO comments in magic-link-request.ts and
 * handoff-exchange.ts.
 */

import { db, sites } from '@wiredhowse/db';
import { ErrorCode, siteKeyHeaderSchema } from '@wiredhowse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../../errors';

export type Site = typeof sites.$inferSelect;

/**
 * Resolves the Site row from the `X-Site-Key` header.
 * Sends a 403 reply and returns `null` on any failure — callers must
 * return immediately when they receive `null`.
 */
export async function resolveSite(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Site | null> {
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
