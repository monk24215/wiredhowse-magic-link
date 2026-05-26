import { db, magicLinks, sites } from '@wiredhowse/db';
import { ErrorCode, magicLinkRequestSchema, siteKeyHeaderSchema } from '@wiredhowse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateToken, hashToken } from '../../lib/crypto';
import { hashBytes, hashForLog } from '../../lib/hashing';
import { addSeconds, nowUtc } from '../../lib/time';
import { applySnippetCors } from '../../middleware/cors';
import { sendMagicLinkEmail } from '../../services/email';
import {
  checkMagicLinkPerEmail,
  checkMagicLinkPerIp,
  checkMagicLinkPerSite,
  setRateLimitHeaders,
} from '../../services/rate-limit';
import { send400, sendError } from '../../errors';
import { config } from '../../config';

const MAGIC_LINK_TTL_SEC = 15 * 60; // 900 seconds (spec: 15-minute lifetime)

type Site = typeof sites.$inferSelect;

/** Resolves site from X-Site-Key header. Sends 403 and returns null on failure. */
async function resolveSite(request: FastifyRequest, reply: FastifyReply): Promise<Site | null> {
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

export async function magicLinkRequestRoutes(app: FastifyInstance): Promise<void> {
  // Handle CORS preflight for browsers that send OPTIONS before POST
  app.options('/magic-link/request', async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;
    applySnippetCors(request, reply, site.allowedOrigins);
  });

  app.post('/magic-link/request', async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;

    // CORS / origin validation — sends reply and returns false if rejected
    const corsOk = applySnippetCors(request, reply, site.allowedOrigins);
    if (!corsOk) return;

    // Site must be live before any work is done
    if (site.state !== 'live') {
      sendError(
        reply,
        403,
        ErrorCode.SITE_DISABLED,
        'This site is not currently accepting authentication requests',
      );
      return;
    }

    // Parse + validate body
    const bodyParsed = magicLinkRequestSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      send400(reply, bodyParsed.error.issues[0]?.message ?? 'Invalid request body');
      return;
    }
    const { email } = bodyParsed.data;

    // Rate limits applied in spec-mandated order: IP → site → email (spec/07)
    // IP and site limits return 429; email limit is silent (prevents enumeration)
    const ip = request.ip;

    const ipResult = await checkMagicLinkPerIp(ip);
    setRateLimitHeaders(reply, {
      limit: ipResult.limit,
      remaining: ipResult.limit - ipResult.current,
      reset: ipResult.resetAt,
    });
    if (!ipResult.allowed) {
      const retryAfter = Math.max(1, ipResult.resetAt - Math.floor(Date.now() / 1000));
      setRateLimitHeaders(reply, {
        limit: ipResult.limit,
        remaining: 0,
        reset: ipResult.resetAt,
        retryAfter,
      });
      sendError(
        reply,
        429,
        ErrorCode.RATE_LIMITED,
        `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
        { retry_after_seconds: retryAfter },
      );
      return;
    }

    const siteResult = await checkMagicLinkPerSite(site.id);
    if (!siteResult.allowed) {
      const retryAfter = Math.max(1, siteResult.resetAt - Math.floor(Date.now() / 1000));
      setRateLimitHeaders(reply, {
        limit: siteResult.limit,
        remaining: 0,
        reset: siteResult.resetAt,
        retryAfter,
      });
      sendError(
        reply,
        429,
        ErrorCode.RATE_LIMITED,
        `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
        { retry_after_seconds: retryAfter },
      );
      return;
    }

    // Email limit is always silent — response is 200 either way to prevent enumeration
    const emailResult = await checkMagicLinkPerEmail(email);

    if (emailResult.allowed) {
      const rawToken = generateToken('wh_ml_');
      const tokenHash = hashToken(rawToken);
      const expiresAt = addSeconds(nowUtc(), MAGIC_LINK_TTL_SEC);
      const ipHash = hashBytes(ip);
      const uaHash = hashBytes(request.headers['user-agent'] ?? '');

      await db.insert(magicLinks).values({
        email,
        siteId: site.id,
        tokenHash,
        expiresAt,
        requestedIpHash: ipHash,
        requestedUserAgentHash: uaHash,
      });

      const magicLinkUrl = `${config.SITE_URL}/v1/magic/redeem?token=${encodeURIComponent(rawToken)}`;

      // Non-blocking — email failure must not block the response
      sendMagicLinkEmail({
        to: email,
        siteDomain: site.domain,
        magicLinkUrl,
        expiresInMinutes: MAGIC_LINK_TTL_SEC / 60,
      }).catch((err: unknown) => {
        request.log.error(
          { err, siteId: site.id, emailHash: hashForLog(email) },
          'Failed to send magic link email',
        );
      });
    } else {
      request.log.info(
        { event: 'email_silent_blocked', emailHash: hashForLog(email), siteId: site.id },
        'Magic-link email silently rate-limited',
      );
    }

    void reply.code(200).send({ data: { sent: true, expires_in_seconds: MAGIC_LINK_TTL_SEC } });
  });
}
