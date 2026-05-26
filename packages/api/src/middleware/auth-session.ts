import { db, endUsers, sessions } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashToken } from '../lib/crypto';

type EndUserRow = typeof endUsers.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    endUser?: EndUserRow;
    sessionId?: string;
  }
}

export async function requireEndUserSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.headers.authorization;

  if (!auth?.startsWith('Bearer wh_s_')) {
    void reply.code(401).send({
      error: { code: ErrorCode.UNAUTHENTICATED, message: 'Missing or invalid session token' },
    });
    return;
  }

  const raw = auth.slice('Bearer '.length);
  const hash = hashToken(raw);
  const now = new Date();

  const rows = await db
    .select({ session: { id: sessions.id }, endUser: endUsers })
    .from(sessions)
    .innerJoin(endUsers, eq(sessions.endUserId, endUsers.id))
    .where(
      and(eq(sessions.tokenHash, hash), gt(sessions.expiresAt, now), isNull(sessions.revokedAt)),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    void reply.code(401).send({
      error: { code: ErrorCode.UNAUTHENTICATED, message: 'Session not found or expired' },
    });
    return;
  }

  request.endUser = row.endUser;
  request.sessionId = row.session.id;
}
