import { db, siteOwnerSessions, siteOwners } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE_MAX_AGE, buildOwnerSessionCookie } from '../lib/cookies';
import { hashToken } from '../lib/crypto';
import { addDays, nowUtc } from '../lib/time';

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
  const now = nowUtc();

  const rows = await db
    .select({
      session: {
        id: siteOwnerSessions.id,
        expiresAt: siteOwnerSessions.expiresAt,
      },
      siteOwner: siteOwners,
    })
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

  // Sliding TTL: extend if less than half the max-age remains.
  // Avoids a DB write on every request while still honouring the sliding contract.
  const halfMaxAgeMs = (SESSION_COOKIE_MAX_AGE / 2) * 1000;
  const remainingMs = row.session.expiresAt.getTime() - now.getTime();

  if (remainingMs < halfMaxAgeMs) {
    const newExpiresAt = addDays(now, 30);
    await db
      .update(siteOwnerSessions)
      .set({ expiresAt: newExpiresAt, lastUsedAt: now })
      .where(eq(siteOwnerSessions.id, row.session.id));
    // Re-issue the browser cookie so its TTL also extends.
    void reply.header('Set-Cookie', buildOwnerSessionCookie(raw));
  } else {
    await db
      .update(siteOwnerSessions)
      .set({ lastUsedAt: now })
      .where(eq(siteOwnerSessions.id, row.session.id));
  }
}
