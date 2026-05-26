import { db, siteOwnerSessions, siteOwners } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashToken } from '../lib/crypto';

type SiteOwnerRow = typeof siteOwners.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    siteOwner?: SiteOwnerRow;
    ownerSessionId?: string;
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key === name) return decodeURIComponent(trimmed.slice(eqIdx + 1).trim());
  }
  return undefined;
}

export async function requireSiteOwnerSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const raw = readCookie(request.headers.cookie, 'wh_owner_session');

  if (!raw) {
    void reply.code(401).send({
      error: { code: ErrorCode.UNAUTHENTICATED, message: 'Dashboard session required' },
    });
    return;
  }

  const hash = hashToken(raw);
  const now = new Date();

  const rows = await db
    .select({ session: { id: siteOwnerSessions.id }, siteOwner: siteOwners })
    .from(siteOwnerSessions)
    .innerJoin(siteOwners, eq(siteOwnerSessions.siteOwnerId, siteOwners.id))
    .where(
      and(
        eq(siteOwnerSessions.tokenHash, hash),
        gt(siteOwnerSessions.expiresAt, now),
        isNull(siteOwnerSessions.revokedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    void reply.code(401).send({
      error: { code: ErrorCode.UNAUTHENTICATED, message: 'Dashboard session not found or expired' },
    });
    return;
  }

  request.siteOwner = row.siteOwner;
  request.ownerSessionId = row.session.id;
}
