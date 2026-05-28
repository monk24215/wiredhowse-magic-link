import dns from 'node:dns/promises';
import { db, sites } from '@wiredhowse/db';
import { ErrorCode } from '@wiredhowse/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { send404, sendError } from '../../errors';
import { addSeconds, nowUtc } from '../../lib/time';
import { checkDomainVerifyPerSite, setRateLimitHeaders } from '../../services/rate-limit';

const DNS_TIMEOUT_MS = 5000;
const META_TIMEOUT_MS = 5000;
const META_MAX_BYTES = 50 * 1024; // 50 KB
const VERIFY_COOLDOWN_SEC = 60;

/** Wraps a promise with a timeout. Rejects if the timeout elapses first. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Check DNS TXT records at `_wiredhowse-verify.<domain>` for the verification token.
 * Returns true if found, false on any failure or mismatch.
 */
async function checkDns(domain: string, verificationToken: string): Promise<boolean> {
  try {
    const records = await withTimeout(
      dns.resolveTxt(`_wiredhowse-verify.${domain}`),
      DNS_TIMEOUT_MS,
      'DNS lookup',
    );
    // Each record is string[][]; inner strings are concatenated to form the value.
    for (const record of records) {
      if (record.join('').includes(verificationToken)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Fetch the site homepage and look for `<meta name="wh-verify" content="...">`.
 * Returns true if content === verificationToken, false on any failure.
 */
async function checkMeta(domain: string, verificationToken: string): Promise<boolean> {
  try {
    const response = await withTimeout(
      fetch(`https://${domain}/`, { signal: AbortSignal.timeout(META_TIMEOUT_MS) }),
      META_TIMEOUT_MS,
      'Meta fetch',
    );

    const reader = response.body?.getReader();
    if (!reader) return false;

    let html = '';
    let bytesRead = 0;
    const decoder = new TextDecoder();

    while (bytesRead < META_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      html += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();

    // Match <meta name="wh-verify" content="..."> with either attribute order.
    const nameFirst =
      /<meta\s[^>]*name\s*=\s*["']wh-verify["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i;
    const contentFirst =
      /<meta\s[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']wh-verify["'][^>]*>/i;

    const match = nameFirst.exec(html) ?? contentFirst.exec(html);
    if (!match) return false;

    return match[1] === verificationToken;
  } catch {
    return false;
  }
}

export async function siteVerifyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/dashboard/sites/:id/verify
   *
   * Trigger a domain ownership check (DNS TXT + HTML meta tag).
   * Rate limited to 1 check per minute per site.
   */
  app.post('/:id/verify', async (request, reply) => {
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

    // Rate limit: 1 check per minute per site.
    const rl = await checkDomainVerifyPerSite(site.id);
    setRateLimitHeaders(reply, {
      limit: rl.limit,
      remaining: Math.max(0, rl.limit - rl.current),
      reset: rl.resetAt,
    });

    if (!rl.allowed) {
      const nextCheckAllowedAt = addSeconds(nowUtc(), VERIFY_COOLDOWN_SEC);
      sendError(
        reply,
        429,
        ErrorCode.RATE_LIMITED,
        'Domain verification is rate limited to 1 check per minute',
        { next_check_allowed_at: nextCheckAllowedAt.toISOString() },
      );
      return;
    }

    // Run DNS and meta checks in parallel.
    const [dnsResult, metaResult] = await Promise.allSettled([
      checkDns(site.domain, site.verificationToken),
      checkMeta(site.domain, site.verificationToken),
    ]);

    const dnsOk = dnsResult.status === 'fulfilled' && dnsResult.value === true;
    const metaOk = metaResult.status === 'fulfilled' && metaResult.value === true;

    if (dnsOk || metaOk) {
      // DNS wins on tie.
      const method = dnsOk ? 'dns' : 'meta';
      const now = nowUtc();

      // Auto-seed allowedOrigins with the verified domain on first verification.
      // Sites start with an empty list; without this the snippet is immediately
      // blocked by the origin check on every request.
      const verifiedOrigin = `https://${site.domain}`;
      const seededOrigins = site.allowedOrigins.includes(verifiedOrigin)
        ? site.allowedOrigins
        : [...site.allowedOrigins, verifiedOrigin];

      await db
        .update(sites)
        .set({ state: 'live', verificationMethod: method, verifiedAt: now, allowedOrigins: seededOrigins })
        .where(eq(sites.id, site.id));

      return reply.code(200).send({ data: { verified: true, method } });
    }

    // Both checks failed.
    const now = nowUtc();
    const nextCheckAllowedAt = addSeconds(now, VERIFY_COOLDOWN_SEC);

    return reply.code(200).send({
      data: {
        verified: false,
        checked_at: now.toISOString(),
        next_check_allowed_at: nextCheckAllowedAt.toISOString(),
      },
    });
  });
}
