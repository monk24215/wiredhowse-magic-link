import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const csp = [
    "default-src 'self'",
    // nonce covers Next.js inline hydration scripts; strict-dynamic
    // propagates trust to chunks loaded by those scripts.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // unsafe-inline required for Tailwind CSS runtime injection.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]
    .join('; ')
    .trim();

  const requestHeaders = new Headers(request.headers);
  // x-nonce is read by the root layout and forwarded to Next.js internals.
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  return response;
}

export const config = {
  matcher: [
    // Run on all page routes. Skip static assets and API proxy paths.
    '/((?!_next/static|_next/image|favicon|v1|api/v1|healthz|readyz).*)',
  ],
};
