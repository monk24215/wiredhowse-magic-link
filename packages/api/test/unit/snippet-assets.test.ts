/**
 * Unit tests — GET /v1/snippet.js, /v1/snippet-ui.js, /v1/snippet.d.ts,
 * GET /v1/snippet/ui
 *
 * fs/promises.readFile is mocked so no real dist/ files are needed.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:fs/promises BEFORE importing the route module.
// ---------------------------------------------------------------------------

const MOCK_JS = Buffer.from('/* mock snippet.js */\n');
const MOCK_UI_JS = Buffer.from('/* mock snippet-ui.js */\n');

const mockReadFile = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

// ---------------------------------------------------------------------------
// Deferred import — must come after vi.mock registrations.
// ---------------------------------------------------------------------------

const { snippetAssetRoutes } = await import('../../src/routes/snippet-assets');

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
  const app = Fastify({ logger: false });
  // Simulate the global onSend hook that stamps X-Request-Id.
  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });
  // Register routes under /v1 to mirror production layout.
  void app.register(snippetAssetRoutes, { prefix: '/v1' });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Snippet asset routes', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();

    // Default: both JS files resolve successfully.
    mockReadFile.mockImplementation((filePath: string) => {
      if (String(filePath).endsWith('snippet.js')) return Promise.resolve(MOCK_JS);
      if (String(filePath).endsWith('snippet-ui.js')) return Promise.resolve(MOCK_UI_JS);
      return Promise.reject(new Error(`Unexpected readFile call: ${String(filePath)}`));
    });
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  // ── GET /v1/snippet.js ────────────────────────────────────────────────────

  describe('GET /v1/snippet.js', () => {
    it('returns 200 with application/javascript content-type', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet.js' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/javascript/);
    });

    it('sets Cache-Control: public, max-age=300, s-maxage=300', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet.js' });

      expect(res.headers['cache-control']).toBe('public, max-age=300, s-maxage=300');
    });

    it('returns the bundle content', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet.js' });

      expect(res.rawPayload).toEqual(MOCK_JS);
    });

    it('reads from SNIPPET_DIST/snippet.js', async () => {
      await app.inject({ method: 'GET', url: '/v1/snippet.js' });

      expect(mockReadFile).toHaveBeenCalledOnce();
      const [path] = mockReadFile.mock.calls[0] as [string];
      expect(path).toMatch(/snippet\.js$/);
      // Must NOT be the ui bundle.
      expect(path).not.toMatch(/snippet-ui\.js$/);
    });

    it('returns 500 when dist file is missing', async () => {
      mockReadFile.mockRejectedValueOnce(
        Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
      );

      const res = await app.inject({ method: 'GET', url: '/v1/snippet.js' });

      expect(res.statusCode).toBe(500);
    });
  });

  // ── GET /v1/snippet-ui.js ─────────────────────────────────────────────────

  describe('GET /v1/snippet-ui.js', () => {
    it('returns 200 with application/javascript content-type', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet-ui.js' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/javascript/);
    });

    it('sets Cache-Control: public, max-age=300, s-maxage=300', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet-ui.js' });

      expect(res.headers['cache-control']).toBe('public, max-age=300, s-maxage=300');
    });

    it('returns the ui bundle content', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet-ui.js' });

      expect(res.rawPayload).toEqual(MOCK_UI_JS);
    });

    it('reads from SNIPPET_DIST/snippet-ui.js', async () => {
      await app.inject({ method: 'GET', url: '/v1/snippet-ui.js' });

      expect(mockReadFile).toHaveBeenCalledOnce();
      const [path] = mockReadFile.mock.calls[0] as [string];
      expect(path).toMatch(/snippet-ui\.js$/);
    });

    it('returns 500 when dist file is missing', async () => {
      mockReadFile.mockRejectedValueOnce(
        Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
      );

      const res = await app.inject({ method: 'GET', url: '/v1/snippet-ui.js' });

      expect(res.statusCode).toBe(500);
    });
  });

  // ── GET /v1/snippet.d.ts ──────────────────────────────────────────────────

  describe('GET /v1/snippet.d.ts', () => {
    it('returns 200 with text/plain content-type', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet.d.ts' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
    });

    it('sets Cache-Control: public, max-age=86400, s-maxage=86400', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet.d.ts' });

      expect(res.headers['cache-control']).toBe('public, max-age=86400, s-maxage=86400');
    });

    it('does NOT call readFile (types are inlined)', async () => {
      await app.inject({ method: 'GET', url: '/v1/snippet.d.ts' });

      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('response body contains WiredhowseAuth interface', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet.d.ts' });

      expect(res.body).toContain('WiredhowseAuth');
    });

    it('response body contains WiredhowseSession interface', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet.d.ts' });

      expect(res.body).toContain('WiredhowseSession');
    });

    it('response body contains window.wiredhowseAuth global declaration', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet.d.ts' });

      expect(res.body).toContain('wiredhowseAuth');
      expect(res.body).toContain('declare global');
    });
  });

  // ── GET /v1/snippet/ui ────────────────────────────────────────────────────

  describe('GET /v1/snippet/ui', () => {
    it('returns 200 with text/html content-type', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    });

    it('sets the correct Content-Security-Policy header', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      expect(res.headers['content-security-policy']).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors *;",
      );
    });

    it('CSP contains frame-ancestors * to allow any parent to embed the iframe', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      expect(res.headers['content-security-policy']).toContain('frame-ancestors *');
    });

    it('CSP does NOT allow unsafe-inline scripts', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      const csp = res.headers['content-security-policy'] as string;
      // script-src must contain 'self' but not 'unsafe-inline'
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("script-src 'unsafe-inline'");
      expect(csp).not.toContain("'unsafe-inline' 'self'");
    });

    it('sets Cache-Control: public, max-age=300, s-maxage=300', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      expect(res.headers['cache-control']).toBe('public, max-age=300, s-maxage=300');
    });

    it('HTML references /v1/snippet-ui.js via <script src>', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      expect(res.body).toContain('src="/v1/snippet-ui.js"');
    });

    it('HTML contains no inline script content (CSP-compliant)', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      // Any <script> tag must have only a src attribute — no inner content.
      // Regex: opening <script> tag followed immediately by </script> or only whitespace.
      const inlineScriptRe = /<script(?![^>]*\bsrc\s*=)[^>]*>[^<]*\S[^<]*<\/script>/i;
      expect(res.body).not.toMatch(inlineScriptRe);
    });

    it('HTML contains no inline event handlers (on* attributes)', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      // No on* attributes (onclick, onload, etc.)
      expect(res.body).not.toMatch(/\bon\w+\s*=/i);
    });

    it('HTML contains no javascript: URLs', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      expect(res.body.toLowerCase()).not.toContain('javascript:');
    });

    it('does NOT call readFile (shell is a static string)', async () => {
      await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('sets X-Request-Id on the response', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet/ui' });

      expect(res.headers['x-request-id']).toBeTruthy();
    });
  });

  // ── Cross-cutting ─────────────────────────────────────────────────────────

  describe('cross-cutting concerns', () => {
    it('each JS route sets X-Request-Id', async () => {
      for (const url of ['/v1/snippet.js', '/v1/snippet-ui.js']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.headers['x-request-id'], `missing X-Request-Id on ${url}`).toBeTruthy();
      }
    });

    it('GET /v1/snippet.d.ts sets X-Request-Id', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/snippet.d.ts' });
      expect(res.headers['x-request-id']).toBeTruthy();
    });
  });
});
