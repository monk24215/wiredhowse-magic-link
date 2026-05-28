/**
 * Static asset routes — JavaScript bundles, TypeScript declarations, iframe shell.
 *
 *   GET /v1/snippet.js      — main snippet bundle (embedded on customer sites)
 *   GET /v1/snippet-ui.js   — iframe UI bundle (loaded inside /v1/snippet/ui)
 *   GET /v1/snippet.d.ts    — TypeScript declarations for window.wiredhowseAuth
 *   GET /v1/snippet/ui      — iframe HTML shell (minimal; no inline scripts)
 *
 * Bundle files are read from packages/snippet/dist/ at request time so the API
 * does not need to restart when bundles are rebuilt during development.
 * The dist path defaults to ../../../snippet/dist relative to this file's
 * compiled location; override with WH_SNIPPET_DIST_DIR for Docker / testing.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Absolute path to packages/snippet/dist/.
 * Works from both:
 *   - tsx dev:  packages/api/src/routes/  → ../../../snippet/dist
 *   - compiled: packages/api/dist/routes/ → ../../../snippet/dist
 */
const SNIPPET_DIST = process.env.WH_SNIPPET_DIST_DIR ?? join(__dirname, '../../../snippet/dist');

/** 5-minute public cache — matches spec § Cache headers. */
const JS_CACHE = 'public, max-age=300, s-maxage=300';

/** 24-hour public cache — types only change on contract bumps. */
const DTS_CACHE = 'public, max-age=86400, s-maxage=86400';

/**
 * CSP for the iframe shell.
 *
 * - default-src 'self'          — baseline; blocks everything not listed.
 * - script-src 'self'           — only /v1/snippet-ui.js (same origin); no inline scripts.
 * - style-src 'self' 'unsafe-inline' — the UI bundle injects a <style> element.
 * - frame-ancestors *           — any customer site may embed this iframe (the whole point).
 *
 * Note: X-Frame-Options: SAMEORIGIN (set by @fastify/helmet) is effectively
 * overridden by CSP frame-ancestors in Chrome 80+/Firefox 78+/Safari 14+.
 */
const IFRAME_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors *;";

/**
 * Minimal HTML shell for the sign-in iframe.
 *
 * Security requirements enforced here:
 *   - No inline scripts          → CSP script-src 'self' does not need 'unsafe-inline'.
 *   - No inline event handlers   → no on* attributes anywhere.
 *   - External script via src    → served from the same origin (/v1/snippet-ui.js).
 */
const IFRAME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in</title>
</head>
<body>
  <script src="/v1/snippet-ui.js"></script>
</body>
</html>
`;

/**
 * TypeScript declaration file for window.wiredhowseAuth.
 * Served at GET /v1/snippet.d.ts.
 * Inlined here (no file read) — types change only on API contract updates.
 */
const SNIPPET_DTS = `// wiredHowse Magic Link — TypeScript declarations
// https://magic-link.wiredhowse.app/v1/snippet.d.ts

interface WiredhowseSession {
  id: string;
  /** ISO 8601 timestamp. */
  expires_at: string;
  end_user: {
    id: string;
    email: string;
    display_name: string | null;
  };
}

interface WiredhowseAuthError {
  code: string;
  message: string;
}

type WiredhowseAuthEvent =
  | 'session'
  | 'signout'
  | 'site_disabled'
  | 'error'
  | 'ready';

interface WiredhowseRequireSessionOptions {
  /** Optional intro text shown inside the email-entry iframe. */
  message?: string;
  /** Override where the magic link returns the user to. Default: current URL. */
  redirectTo?: string;
}

interface WiredhowseAuth {
  /** SDK version string. */
  readonly version: string;
  /**
   * Returns the current session if valid and not expired, else null.
   * Makes one server round-trip to validate.
   */
  getSession(): Promise<WiredhowseSession | null>;
  /**
   * Returns a valid session. If none exists, renders the sign-in iframe and
   * waits for the user to complete the magic-link flow.
   * Rejects only on unrecoverable errors (site disabled, network down).
   */
  requireSession(
    options?: WiredhowseRequireSessionOptions,
  ): Promise<WiredhowseSession>;
  /** Signs the current user out (server-side revoke + localStorage clear). */
  signOut(): Promise<void>;
  /** Subscribes to an auth event. Returns an unsubscribe function. */
  on(event: 'session', callback: (session: WiredhowseSession) => void): () => void;
  on(event: 'error', callback: (error: WiredhowseAuthError) => void): () => void;
  on(event: 'signout' | 'site_disabled' | 'ready', callback: () => void): () => void;
  on(event: WiredhowseAuthEvent, callback: (...args: unknown[]) => void): () => void;
  /** Unsubscribes a previously registered callback by reference. */
  off(event: WiredhowseAuthEvent, callback: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    /**
     * wiredHowse Magic Link client.
     * Available after the snippet script has loaded and executed.
     *
     * Before the script loads, use the async-queue pattern:
     *   window.wiredhowseAuth = window.wiredhowseAuth || { q: [] };
     *   window.wiredhowseAuth.q.push(['on', 'session', (s) => console.log(s)]);
     */
    wiredhowseAuth: WiredhowseAuth;
  }
}

export {};
`;

export async function snippetAssetRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /snippet.js ──────────────────────────────────────────────────────────
  // CORP must be cross-origin: snippet.js is loaded via <script src> on customer
  // sites. Without this, customer sites that enable COEP (Cross-Origin-Embedder-
  // Policy) would be blocked from loading the script.
  app.get('/snippet.js', async (_req, reply) => {
    const src = await readFile(join(SNIPPET_DIST, 'snippet.js'));
    return reply
      .code(200)
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', JS_CACHE)
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(src);
  });

  // ── GET /snippet-ui.js ───────────────────────────────────────────────────────
  // Loaded only from within the iframe (same-origin context) — no CORP override needed.
  app.get('/snippet-ui.js', async (_req, reply) => {
    const src = await readFile(join(SNIPPET_DIST, 'snippet-ui.js'));
    return reply
      .code(200)
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', JS_CACHE)
      .send(src);
  });

  // ── GET /snippet.d.ts ────────────────────────────────────────────────────────
  app.get('/snippet.d.ts', async (_req, reply) => {
    return reply
      .code(200)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Cache-Control', DTS_CACHE)
      .send(SNIPPET_DTS);
  });

  // ── GET /snippet/ui ──────────────────────────────────────────────────────────
  // Iframe shell: minimal HTML, no inline scripts, strict CSP.
  // X-Frame-Options set by @fastify/helmet is removed here — CSP frame-ancestors
  // takes precedence in all target browsers (Chrome 80+/Firefox 78+/Safari 14+).
  app.get('/snippet/ui', async (_req, reply) => {
    reply.removeHeader('x-frame-options');
    return reply
      .code(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', IFRAME_CSP)
      .header('Cache-Control', JS_CACHE)
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(IFRAME_HTML);
  });
}
