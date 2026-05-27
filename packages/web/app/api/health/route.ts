import { NextResponse } from 'next/server';

/**
 * GET /api/health
 *
 * Shallow health check for the Next.js web service.
 * Railway uses this endpoint to determine whether the container is ready
 * to receive traffic.  Returns 200 as long as the Next.js runtime is up.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}
