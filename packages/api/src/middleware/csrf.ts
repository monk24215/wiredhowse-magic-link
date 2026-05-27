import { timingSafeEqual } from 'node:crypto';
import { ErrorCode } from '@wiredhowse/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_COOKIE } from '../lib/cookies';

/**
 * Parse a single named cookie from a raw Cookie header string.
 * Exported for use in route modules that need to inspect the CSRF cookie
 * without importing the full middleware (e.g. issuing a fresh token on GET).
 */
export function readCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key === name) {
      return decodeURIComponent(trimmed.slice(eqIdx + 1).trim());
    }
  }
  return undefined;
}

/**
 * CSRF double-submit cookie protection.
 *
 * For any state-changing request (POST, PUT, PATCH, DELETE), the client must
 * include an X-CSRF-Token header whose value matches the wh_csrf cookie.
 *
 * The wh_csrf cookie is not HttpOnly, so the SPA can read it via document.cookie
 * and echo it back in the header. An attacker on a different origin cannot read
 * the cookie value, so they cannot forge the header even if they can trigger a
 * cross-site request.
 *
 * Safe methods (GET, HEAD, OPTIONS) are skipped — they must not modify state.
 */
export async function requireCsrfToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  const cookieToken = readCookieValue(request.headers.cookie, CSRF_COOKIE);
  const headerToken = request.headers['x-csrf-token'];

  const headerStr = Array.isArray(headerToken) ? headerToken[0] : headerToken;

  if (!cookieToken || !headerStr) {
    void reply.code(403).send({
      error: { code: ErrorCode.CSRF_INVALID, message: 'CSRF token missing' },
    });
    return;
  }

  // Constant-time comparison to prevent timing attacks.
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(headerStr);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    void reply.code(403).send({
      error: { code: ErrorCode.CSRF_INVALID, message: 'CSRF token invalid' },
    });
    return;
  }
}
