import { ErrorCode } from '@wiredhowse/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

const SNIPPET_ALLOWED_METHODS = 'POST, OPTIONS';
const SNIPPET_ALLOWED_HEADERS = 'Content-Type, Authorization, X-Site-Key';

// Our own service origin — the iframe at /v1/snippet/ui lives here and calls
// the snippet API directly (same-origin fetch, but browsers still send Origin
// on POST). Requests from this origin are always trusted; the site key is the
// authenticator for per-site scoping.
const OWN_ORIGIN = new URL(process.env['SITE_URL'] ?? 'https://magic-link.wiredhowse.app').origin;

// Extracts just the origin (scheme + host + port) from a stored URL string.
// Stored entries may have been saved with paths before normalization was enforced.
// Returns null for opaque or unparseable values so they never match.
function extractOrigin(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

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

  if (!origin || origin === OWN_ORIGIN) {
    // No origin = server-to-server. OWN_ORIGIN = iframe making a same-service call.
    // Both are trusted; skip the per-site allowlist.
    return true;
  }

  // Normalize stored entries to bare origins before comparing. This handles
  // entries saved before write-time normalization was enforced (e.g., URLs
  // with paths like https://example.com/page that should match the browser's
  // Origin: https://example.com).
  if (!allowedOrigins.some(stored => extractOrigin(stored) === origin)) {
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
