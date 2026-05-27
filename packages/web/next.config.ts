import type { NextConfig } from 'next';

// Consumed at build time by the Next.js rewrite engine.
// In Railway: set INTERNAL_API_URL=http://<api-private-domain>:3001 on the web service.
// In local dev: falls back to http://localhost:3001 when the env var is absent.
const internalApiUrl = process.env.INTERNAL_API_URL ?? 'http://localhost:3001';

const config: NextConfig = {
  async rewrites() {
    return [
      // ── Public-facing API routes ─────────────────────────────────────────
      // Snippet (/v1/snippet.js, /v1/snippet-iframe.html), magic-link redemption
      // (/v1/magic/*), session/handoff routes — all hit from external origins
      // or browser navigation.  Must proxy the entire /v1/* tree.
      {
        source: '/v1/:path*',
        destination: `${internalApiUrl}/v1/:path*`,
      },
      // Health / readiness probes — Railway and uptime monitors hit these.
      {
        source: '/healthz',
        destination: `${internalApiUrl}/healthz`,
      },
      {
        source: '/readyz',
        destination: `${internalApiUrl}/readyz`,
      },
      // ── Dashboard client-side API calls ──────────────────────────────────
      // The browser-side api.ts client uses /api/v1 as its base so that
      // requests stay same-origin (avoids CORS on the dashboard itself).
      {
        source: '/api/v1/:path*',
        destination: `${internalApiUrl}/v1/:path*`,
      },
    ];
  },
};

export default config;
