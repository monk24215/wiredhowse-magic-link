import { ErrorCode } from '@wiredhowse/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

const SNIPPET_ALLOWED_METHODS = 'POST, OPTIONS';
const SNIPPET_ALLOWED_HEADERS = 'Content-Type, Authorization, X-Site-Key';

/**
 * Called by snippet route preHandlers after they have resolved the site's
 * allowed_origins list. Sets CORS response headers and terminates OPTIONS
 * preflight requests with 204. Returns false if the origin is rejected (reply
 * already sent); callers must return immediately in that case.
 */
export function applySnippetCors(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[],
): boolean {
  const origin = request.headers.origin;

  if (!origin) {
    // Server-to-server call — no CORS headers needed.
    return true;
  }

  if (!allowedOrigins.includes(origin)) {
    void reply.code(403).send({
      error: { code: ErrorCode.ORIGIN_NOT_ALLOWED, message: 'Origin not in allowed list' },
    });
    return false;
  }

  void reply.header('Access-Control-Allow-Origin', origin);
  void reply.header('Access-Control-Allow-Methods', SNIPPET_ALLOWED_METHODS);
  void reply.header('Access-Control-Allow-Headers', SNIPPET_ALLOWED_HEADERS);
  void reply.header('Vary', 'Origin');

  if (request.method === 'OPTIONS') {
    void reply.header('Access-Control-Max-Age', '86400');
    void reply.code(204).send('');
    return false;
  }

  return true;
}
