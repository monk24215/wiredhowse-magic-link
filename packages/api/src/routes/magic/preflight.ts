import { db, magicLinks, sites } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sendError } from '../../errors';
import { hashToken } from '../../lib/crypto';
import { maskEmail } from '../../lib/mask-email';

const ML_TOKEN_RE = /^wh_ml_[A-Za-z0-9_-]+$/;

export async function magicPreflightRoutes(app: FastifyInstance): Promise<void> {
  app.get('/preflight', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');

    const token = (request.query as Record<string, string>)['token'];

    if (!token || !ML_TOKEN_RE.test(token)) {
      return sendError(reply, 404, ErrorCode.INVALID_TOKEN, 'Magic link not found or expired');
    }

    const tokenHash = hashToken(token);
    const [ml] = await db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.tokenHash, tokenHash))
      .limit(1);

    if (!ml || ml.redeemedAt !== null || ml.expiresAt < new Date()) {
      return sendError(reply, 404, ErrorCode.INVALID_TOKEN, 'Magic link not found or expired');
    }

    const [site] = await db
      .select({ domain: sites.domain })
      .from(sites)
      .where(eq(sites.id, ml.siteId))
      .limit(1);

    return reply.code(200).send({
      data: {
        email: maskEmail(ml.email),
        site_domain: site?.domain ?? '',
        expires_at: ml.expiresAt.toISOString(),
      },
    });
  });
}
